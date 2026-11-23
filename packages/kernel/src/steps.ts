import type { Db, Event, Scope } from "./types.ts";
import { AmbiguousStep, KernelError, SuspendRun } from "./types.ts";

/** Preserve code and details when an error is persisted; operators triage from these. */
function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof KernelError) {
    return { code: err.code, message: err.message, details: err.details };
  }
  return { code: "UNHANDLED", message: err instanceof Error ? err.message : String(err) };
}
import type { EventLog } from "./log.ts";
import { ulid } from "./ulid.ts";

export type StepOptions = {
  /** false => the step may not be blindly retried after an interrupted attempt. */
  idempotent?: boolean;
};

export type StepCtx = {
  runId: string;
  attempt: number;
  scope: Scope;
  /** Memoised side effect. Completed steps are never re-executed on resume. */
  step<T>(key: string, fn: () => Promise<T>, opts?: StepOptions): Promise<T>;
  emit(type: string, payload: unknown): Promise<Event>;
  budget: { spentUsd(): number; charge(usd: number): void; assertUnder(limit: number): void };
  signal: AbortSignal;
};

export type FlowDefinition<I = unknown, O = unknown> = {
  kind: string;
  maxAttempts?: number;
  run(ctx: StepCtx, input: I): Promise<O>;
};

export type RunRecord = {
  id: string;
  kind: string;
  state: "queued" | "running" | "completed" | "failed" | "paused";
  output: unknown;
  error: unknown;
  attempt: number;
};

export class BudgetExceeded extends KernelError {
  constructor(spent: number, limit: number) {
    super(
      "BUDGET_EXCEEDED",
      `Flow spent $${spent.toFixed(4)}, limit $${limit.toFixed(4)}`,
      { spent, limit },
      false,
    );
  }
}

/**
 * The durable step runtime. One engine serves provisioning state machines, flow runs,
 * triggers and sync jobs. Recovery is not a feature bolted on top -- it is the direct
 * consequence of committing each step's result in its own transaction.
 */
export class StepRuntime {
  #db: Db;
  #log: EventLog;
  #defs = new Map<string, FlowDefinition<never, unknown>>();
  #leaseMs: number;

  constructor(db: Db, log: EventLog, opts: { leaseMs?: number } = {}) {
    this.#db = db;
    this.#log = log;
    this.#leaseMs = opts.leaseMs ?? 30_000;
  }

  register<I, O>(def: FlowDefinition<I, O>): this {
    if (this.#defs.has(def.kind)) throw new Error(`Flow "${def.kind}" already registered`);
    this.#defs.set(def.kind, def as unknown as FlowDefinition<never, unknown>);
    return this;
  }

  async start<I>(kind: string, input: I, scope: Scope): Promise<string> {
    if (!this.#defs.has(kind)) throw new Error(`Unknown flow kind "${kind}"`);
    const id = ulid();
    await this.#db.query(
      `insert into flow_runs (id, kind, tenant_id, workspace_id, project_id, input, state)
       values ($1,$2,$3,$4,$5,$6,'queued')`,
      [id, kind, scope.tenantId, scope.workspaceId, scope.projectId ?? null, JSON.stringify(input)],
    );
    return id;
  }

  async get(runId: string): Promise<RunRecord | null> {
    const r = await this.#db.query<RunRecord>(
      `select id, kind, state, output, error, attempt from flow_runs where id = $1`,
      [runId],
    );
    return r.rows[0] ?? null;
  }

  async steps(runId: string): Promise<Array<{ step_key: string; state: string; output: unknown }>> {
    const r = await this.#db.query<{ step_key: string; state: string; output: unknown }>(
      `select step_key, state, output from flow_steps where run_id = $1 order by at asc`,
      [runId],
    );
    return r.rows;
  }

  /**
   * Answer a suspended step. The answer is written as that step's completed result, so
   * memoisation does the rest: the node returns it on the next execute() without re-running.
   */
  async resume(runId: string, stepKey: string, answer: unknown): Promise<RunRecord> {
    const r = await this.#db.query<{ state: string }>(
      `select state from flow_runs where id = $1`,
      [runId],
    );
    if (!r.rows[0]) throw new Error(`No such run "${runId}"`);
    if (r.rows[0].state !== "paused") {
      throw new KernelError("NOT_PAUSED", `Run "${runId}" is ${r.rows[0].state}, not paused`, {
        runId,
        state: r.rows[0].state,
      });
    }
    await this.#db.query(
      `insert into flow_steps (run_id, step_key, state, idempotent, output)
       values ($1,$2,'completed',true,$3)
       on conflict (run_id, step_key)
         do update set state='completed', output=$3, error=null, at=now()`,
      [runId, stepKey, JSON.stringify(answer ?? null)],
    );
    await this.#db.query(`update flow_runs set state='queued', error=null where id=$1`, [runId]);
    return (await this.get(runId))!;
  }

  /** Runs paused on a human decision, for the approval inbox. */
  async awaitingDecision(): Promise<Array<{ id: string; kind: string; question: unknown }>> {
    const r = await this.#db.query<{ id: string; kind: string; error: { details?: { question?: unknown } } }>(
      `select id, kind, error from flow_runs where state = 'paused' order by id`,
    );
    return r.rows.map((x) => ({ id: x.id, kind: x.kind, question: x.error?.details?.question }));
  }

  /** Runs whose worker died: still marked running, but the lease has expired. */
  async recoverable(now: Date = new Date()): Promise<string[]> {
    const r = await this.#db.query<{ id: string }>(
      `select id from flow_runs where state = 'running' and lease_until < $1`,
      [now.toISOString()],
    );
    return r.rows.map((x) => x.id);
  }

  async #recordStepStarted(
    runId: string,
    key: string,
    idempotent: boolean,
    attempt: number,
  ): Promise<void> {
    await this.#db.query(
      `insert into flow_steps (run_id, step_key, state, idempotent, attempt)
       values ($1,$2,'started',$3,$4)
       on conflict (run_id, step_key) do update set state = 'started', attempt = $4`,
      [runId, key, idempotent, attempt],
    );
  }

  /**
   * Execute (or resume) a run to completion. Safe to call repeatedly: completed steps
   * replay from their stored results, so the only work done is what is actually left.
   */
  async execute(runId: string, opts: { budgetUsd?: number } = {}): Promise<RunRecord> {
    const head = await this.#db.query<{
      kind: string;
      input: unknown;
      attempt: number;
      state: string;
      tenant_id: string;
      workspace_id: string;
      project_id: string | null;
    }>(
      `select kind, input, attempt, state, tenant_id, workspace_id, project_id
       from flow_runs where id = $1`,
      [runId],
    );
    const row = head.rows[0];
    if (!row) throw new Error(`No such run "${runId}"`);
    if (row.state === "completed" || row.state === "failed") {
      return (await this.get(runId))!;
    }

    const def = this.#defs.get(row.kind);
    if (!def) throw new Error(`Unknown flow kind "${row.kind}"`);

    const attempt = row.attempt + 1;
    await this.#db.query(
      `update flow_runs set state = 'running', attempt = $2, lease_until = $3 where id = $1`,
      [runId, attempt, new Date(Date.now() + this.#leaseMs).toISOString()],
    );

    const scope: Scope = {
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      projectId: row.project_id ?? undefined,
    };
    const abort = new AbortController();
    let spent = 0;
    const self = this;

    const ctx: StepCtx = {
      runId,
      attempt,
      scope,
      signal: abort.signal,
      budget: {
        spentUsd: () => spent,
        charge: (usd: number) => {
          spent += usd;
        },
        assertUnder: (limit: number) => {
          if (spent >= limit) throw new BudgetExceeded(spent, limit);
        },
      },
      emit: (type: string, payload: unknown) =>
        self.#log.append({
          ...scope,
          stream: `flowrun:${runId}`,
          type,
          payload,
          actor: { kind: "system", id: `flow:${row.kind}` },
          correlationId: runId,
        }),
      async step<T>(key: string, fn: () => Promise<T>, so: StepOptions = {}): Promise<T> {
        const idempotent = so.idempotent !== false;
        const prior = await self.#db.query<{ state: string; output: unknown }>(
          `select state, output from flow_steps where run_id = $1 and step_key = $2`,
          [runId, key],
        );
        const p = prior.rows[0];
        if (p?.state === "completed") return p.output as T;
        // For a non-idempotent step, ANY prior attempt -- interrupted or failed -- leaves it
        // unknown whether the outside world already acted. Refuse rather than double-charge.
        if (p && p.state !== "completed" && !idempotent) throw new AmbiguousStep(runId, key);

        // Committed before the side effect runs, so an interrupted non-idempotent step
        // is detectable on resume rather than silently repeated.
        await self.#recordStepStarted(runId, key, idempotent, attempt);

        try {
          const out = await fn();
          await self.#db.query(
            `update flow_steps set state = 'completed', output = $3, at = now()
             where run_id = $1 and step_key = $2`,
            [runId, key, JSON.stringify(out ?? null)],
          );
          return out;
        } catch (err) {
          await self.#db.query(
            `update flow_steps set state = $4, error = $3, at = now()
             where run_id = $1 and step_key = $2`,
            [runId, key, JSON.stringify(serializeError(err)), idempotent ? "failed" : "ambiguous"],
          );
          throw err;
        }
      },
    };

    try {
      const output = await def.run(ctx as never, row.input as never);
      if (opts.budgetUsd !== undefined) ctx.budget.assertUnder(opts.budgetUsd);
      await this.#db.query(
        `update flow_runs set state='completed', output=$2, ended_at=now(), lease_until=null
         where id=$1`,
        [runId, JSON.stringify(output ?? null)],
      );
    } catch (err) {
      if (err instanceof SuspendRun) {
        // Not a failure: the flow is waiting on a person. Park it and surface the question.
        await this.#db.query(
          `update flow_runs set state='paused', error=$2, lease_until=null where id=$1`,
          [runId, JSON.stringify(serializeError(err))],
        );
        return (await this.get(runId))!;
      }
      const maxAttempts = def.maxAttempts ?? 3;
      // A deterministic error will fail identically on every attempt; do not burn retries.
      const deterministic = err instanceof KernelError && !err.retryable;
      const terminal = attempt >= maxAttempts || deterministic;
      await this.#db.query(
        `update flow_runs set state=$2, error=$3, lease_until=null,
           ended_at = case when $2 = 'failed' then now() else null end
         where id=$1`,
        [runId, terminal ? "failed" : "queued", JSON.stringify(serializeError(err))],
      );
    }
    return (await this.get(runId))!;
  }
}
