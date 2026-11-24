import type { Db } from "./types.ts";
import type { RunRecord, StepRuntime } from "./steps.ts";

export type WorkerOptions = {
  /** How often to look for work. */
  pollMs?: number;
  /** How often to push the lease forward while a run is executing. */
  renewMs?: number;
  /** How many runs this worker executes at once. */
  concurrency?: number;
  onError?: (where: string, err: unknown) => void;
};

export type WorkerStats = {
  claimed: number;
  completed: number;
  failed: number;
  recovered: number;
  renewals: number;
};

/**
 * The thing that actually drives runs.
 *
 * Without this, `recoverable()` had only a test caller and the design's promise that
 * "another worker picks it up" was not implemented: a run whose executor died stayed
 * `running` with an expired lease forever.
 *
 * Two jobs:
 *   1. Claim queued runs, and reclaim ones whose lease has expired.
 *   2. Renew the lease of a run it is executing, so a slow-but-alive run is not
 *      stolen by a second worker halfway through.
 */
export class Worker {
  #db: Db;
  #steps: StepRuntime;
  #opts: Required<Omit<WorkerOptions, "onError">> & Pick<WorkerOptions, "onError">;
  #running = new Map<string, NodeJS.Timeout>();
  #stop = false;
  #loop: Promise<void> | null = null;
  readonly stats: WorkerStats = { claimed: 0, completed: 0, failed: 0, recovered: 0, renewals: 0 };

  constructor(db: Db, steps: StepRuntime, opts: WorkerOptions = {}) {
    this.#db = db;
    this.#steps = steps;
    this.#opts = {
      pollMs: opts.pollMs ?? 500,
      renewMs: opts.renewMs ?? 10_000,
      concurrency: opts.concurrency ?? 4,
      onError: opts.onError,
    };
  }

  /**
   * Atomically take one run. The conditional UPDATE is what stops two workers
   * claiming the same row: exactly one of them gets a returned id.
   */
  async claimOne(leaseMs: number): Promise<string | null> {
    const until = new Date(Date.now() + leaseMs).toISOString();
    const r = await this.#db.query<{ id: string; was: string }>(
      `update flow_runs
         set state = 'running', lease_until = $1
       where id = (
         select id from flow_runs
          where state = 'queued'
             or (state = 'running' and lease_until < now())
          order by created_at
          limit 1
          for update skip locked
       )
       returning id, state as was`,
      [until],
    );
    return r.rows[0]?.id ?? null;
  }

  /** Push the lease forward for a run this worker is still executing. */
  async renew(runId: string, leaseMs: number): Promise<boolean> {
    const until = new Date(Date.now() + leaseMs).toISOString();
    const r = await this.#db.query<{ id: string }>(
      `update flow_runs set lease_until = $2
       where id = $1 and state = 'running'
       returning id`,
      [runId, until],
    );
    if (r.rows.length) this.stats.renewals++;
    return r.rows.length > 0;
  }

  /** Execute one run with its lease kept alive for as long as it takes. */
  async runOne(runId: string, leaseMs: number): Promise<RunRecord | null> {
    const timer = setInterval(() => {
      void this.renew(runId, leaseMs).catch((e) => this.#opts.onError?.("renew", e));
    }, this.#opts.renewMs);
    this.#running.set(runId, timer);
    try {
      return await this.#steps.execute(runId);
    } catch (err) {
      this.#opts.onError?.("execute", err);
      return null;
    } finally {
      clearInterval(timer);
      this.#running.delete(runId);
    }
  }

  /** One pass: claim up to `concurrency` runs and execute them. Returns how many ran. */
  async tick(leaseMs = 30_000): Promise<number> {
    const free = this.#opts.concurrency - this.#running.size;
    if (free <= 0) return 0;

    const ids: string[] = [];
    for (let i = 0; i < free; i++) {
      const id = await this.claimOne(leaseMs);
      if (!id) break;
      ids.push(id);
      this.stats.claimed++;
    }
    if (ids.length === 0) return 0;

    const results = await Promise.all(ids.map((id) => this.runOne(id, leaseMs)));
    for (const r of results) {
      if (r?.state === "completed") this.stats.completed++;
      else if (r?.state === "failed") this.stats.failed++;
    }
    return ids.length;
  }

  start(leaseMs = 30_000): void {
    if (this.#loop) return;
    this.#stop = false;
    this.#loop = (async () => {
      while (!this.#stop) {
        try {
          const did = await this.tick(leaseMs);
          if (did === 0) await new Promise((r) => setTimeout(r, this.#opts.pollMs));
        } catch (err) {
          this.#opts.onError?.("tick", err);
          await new Promise((r) => setTimeout(r, this.#opts.pollMs));
        }
      }
    })();
  }

  async stop(): Promise<void> {
    this.#stop = true;
    for (const t of this.#running.values()) clearInterval(t);
    this.#running.clear();
    await this.#loop;
    this.#loop = null;
  }

  get inFlight(): string[] {
    return [...this.#running.keys()];
  }
}
