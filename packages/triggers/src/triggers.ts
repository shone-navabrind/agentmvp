import { createHmac, timingSafeEqual } from "node:crypto";
import type { Db, Event, EventLog, Scope, StepRuntime } from "@harness/kernel";
import { KernelError, ulid } from "@harness/kernel";

export type ConcurrencyPolicy = "allow" | "skip" | "queue" | "cancel-previous";

export type TriggerSource =
  | { kind: "event"; match: string; where?: { path: string; equals: unknown } }
  | { kind: "cron"; expression: string; tz?: string }
  | { kind: "webhook"; token: string; secret: string }
  | { kind: "repo"; repo: string; on: Array<"push" | "pull_request" | "tag"> };

export type TriggerAction =
  | { kind: "flow"; flowKind: string; input?: Record<string, unknown> }
  | { kind: "emit"; type: string; payload: Record<string, unknown> };

export type Trigger = {
  id: string;
  projectId: string;
  name: string;
  source: TriggerSource;
  action: TriggerAction;
  enabled: boolean;
  concurrency: ConcurrencyPolicy;
  /** Max firings per window; beyond this the firing is dropped to the DLQ. */
  rateLimit?: { perMinute: number };
};

export type Firing = {
  id: string;
  triggerId: string;
  at: number;
  state: "fired" | "skipped" | "rate-limited" | "failed";
  runId?: string;
  reason?: string;
  correlationId: string;
};

export class WebhookRejected extends KernelError {
  constructor(reason: string) {
    super("WEBHOOK_REJECTED", `Inbound webhook rejected: ${reason}`, { reason }, false);
  }
}

/** HMAC-SHA256 over `${timestamp}.${body}`, the shape every sane provider uses. */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export function verifyWebhook(
  secret: string,
  timestamp: number,
  body: string,
  signature: string,
  opts: { now?: number; toleranceMs?: number } = {},
): void {
  const now = opts.now ?? Date.now();
  const tolerance = opts.toleranceMs ?? 5 * 60 * 1000;
  if (Math.abs(now - timestamp) > tolerance) throw new WebhookRejected("timestamp outside tolerance");
  const expected = Buffer.from(signWebhook(secret, timestamp, body));
  const got = Buffer.from(signature);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
    throw new WebhookRejected("bad signature");
  }
}

/** Minimal 5-field cron. Supports `*`, `*​/n`, lists and ranges -- no seconds, no @macros. */
export function cronMatches(expr: string, d: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron must have 5 fields, got ${fields.length}`);
  const values = [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay()];
  return fields.every((f, i) => fieldMatches(f, values[i]));
}

function fieldMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    const [range, stepStr] = part.split("/");
    const step = stepStr ? Number(stepStr) : 1;
    if (range === "*") return value % step === 0;
    if (range.includes("-")) {
      const [lo, hi] = range.split("-").map(Number);
      return value >= lo && value <= hi && (value - lo) % step === 0;
    }
    return Number(range) === value;
  });
}

function dig(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((cur, k) => {
    if (cur == null || typeof cur !== "object") return undefined;
    return (cur as Record<string, unknown>)[k];
  }, obj);
}

/**
 * One runtime for hooks, schedules, inbound webhooks and repo events. All four produce
 * the same thing -- a job on the step runtime -- so they share concurrency policy,
 * rate limiting, a dead-letter queue and a correlation id you can trace end to end.
 */
export class TriggerEngine {
  #db: Db;
  #log: EventLog;
  #steps: StepRuntime;
  #triggers = new Map<string, Trigger>();
  #firings: Firing[] = [];
  #inFlight = new Map<string, string>();
  #now: () => number;

  constructor(opts: { db: Db; log: EventLog; steps: StepRuntime; now?: () => number }) {
    this.#db = opts.db;
    this.#log = opts.log;
    this.#steps = opts.steps;
    this.#now = opts.now ?? Date.now;
  }

  register(t: Omit<Trigger, "id"> & { id?: string }): Trigger {
    const trigger: Trigger = { id: t.id ?? `trg-${ulid().slice(-8)}`, ...t } as Trigger;
    this.#triggers.set(trigger.id, trigger);
    return trigger;
  }

  list(projectId?: string): Trigger[] {
    return [...this.#triggers.values()].filter((t) => !projectId || t.projectId === projectId);
  }

  firings(triggerId?: string): Firing[] {
    return this.#firings.filter((f) => !triggerId || f.triggerId === triggerId);
  }

  deadLetters(): Firing[] {
    return this.#firings.filter((f) => f.state === "rate-limited" || f.state === "failed");
  }

  #rateLimited(t: Trigger): boolean {
    if (!t.rateLimit) return false;
    const cutoff = this.#now() - 60_000;
    const recent = this.#firings.filter(
      (f) => f.triggerId === t.id && f.at >= cutoff && f.state === "fired",
    );
    return recent.length >= t.rateLimit.perMinute;
  }

  async #fire(t: Trigger, scope: Scope, payload: unknown): Promise<Firing> {
    const correlationId = ulid();
    const record = (state: Firing["state"], extra: Partial<Firing> = {}): Firing => {
      const f: Firing = { id: ulid(), triggerId: t.id, at: this.#now(), state, correlationId, ...extra };
      this.#firings.push(f);
      return f;
    };

    if (!t.enabled) return record("skipped", { reason: "disabled" });
    if (this.#rateLimited(t)) return record("rate-limited", { reason: "rate limit exceeded" });

    const running = this.#inFlight.get(t.id);
    if (running) {
      if (t.concurrency === "skip") return record("skipped", { reason: `already running ${running}` });
      if (t.concurrency === "cancel-previous") this.#inFlight.delete(t.id);
      // "allow" and "queue" both proceed; the step runtime serialises "queue" by lease.
    }

    try {
      if (t.action.kind === "emit") {
        await this.#log.append({
          ...scope,
          stream: `project:${scope.projectId}`,
          type: t.action.type,
          actor: { kind: "system", id: `trigger:${t.id}` },
          payload: t.action.payload,
          correlationId,
        });
        return record("fired");
      }
      const runId = await this.#steps.start(
        t.action.flowKind,
        { ...t.action.input, trigger: { id: t.id, name: t.name }, payload },
        scope,
      );
      this.#inFlight.set(t.id, runId);
      return record("fired", { runId });
    } catch (err) {
      return record("failed", { reason: String(err) });
    }
  }

  complete(triggerId: string): void {
    this.#inFlight.delete(triggerId);
  }

  /** Dispatch an event to every matching event-source trigger. */
  async onEvent(ev: Event): Promise<Firing[]> {
    const out: Firing[] = [];
    for (const t of this.#triggers.values()) {
      if (t.source.kind !== "event") continue;
      if (!globMatch(t.source.match, ev.type)) continue;
      if (t.source.where && dig(ev.payload, t.source.where.path) !== t.source.where.equals) continue;
      out.push(
        await this.#fire(
          t,
          { tenantId: ev.tenantId, workspaceId: ev.workspaceId, projectId: ev.projectId ?? undefined },
          ev,
        ),
      );
    }
    return out;
  }

  /** Called once a minute by the scheduler worker. */
  async tick(at: Date, scope: Scope): Promise<Firing[]> {
    const out: Firing[] = [];
    for (const t of this.#triggers.values()) {
      if (t.source.kind !== "cron") continue;
      if (!cronMatches(t.source.expression, at)) continue;
      out.push(await this.#fire(t, scope, { firedAt: at.toISOString() }));
    }
    return out;
  }

  /** Inbound webhook: verify, then fire. Unverified payloads never become events. */
  async onWebhook(
    token: string,
    body: string,
    headers: { timestamp: number; signature: string },
    scope: Scope,
  ): Promise<Firing> {
    const t = [...this.#triggers.values()].find(
      (x) => x.source.kind === "webhook" && x.source.token === token,
    );
    if (!t) throw new WebhookRejected("unknown token");
    const src = t.source as Extract<TriggerSource, { kind: "webhook" }>;
    verifyWebhook(src.secret, headers.timestamp, body, headers.signature, { now: this.#now() });

    let parsed: unknown = body;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new WebhookRejected("body is not JSON");
    }
    return this.#fire(t, scope, parsed);
  }

  async onRepoEvent(
    repo: string,
    kind: "push" | "pull_request" | "tag",
    payload: unknown,
    scope: Scope,
  ): Promise<Firing[]> {
    const out: Firing[] = [];
    for (const t of this.#triggers.values()) {
      if (t.source.kind !== "repo") continue;
      if (t.source.repo !== repo || !t.source.on.includes(kind)) continue;
      out.push(await this.#fire(t, scope, { repo, kind, payload }));
    }
    return out;
  }
}

function globMatch(glob: string, s: string): boolean {
  const re = new RegExp(
    "^" + glob.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
  );
  return re.test(s);
}
