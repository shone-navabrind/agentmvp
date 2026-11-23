/** Core kernel types. These are the contracts everything else in the platform codes against. */

export type ActorKind = "user" | "agent" | "system" | "plugin";

export type Actor = { kind: ActorKind; id: string };

export type Scope = {
  tenantId: string;
  workspaceId: string;
  projectId?: string;
};

/** An append-only fact. Nothing in the platform changes state without emitting one of these. */
export type Event<P = unknown> = {
  id: string; // ULID, globally monotonic
  stream: string; // "project:<id>" | "session:<id>" | "flowrun:<id>" | ...
  seq: string; // per-stream, gapless, 1-based (string: bigint doesn't survive JSON)
  type: string; // registered in the schema registry
  tenantId: string;
  workspaceId: string;
  projectId: string | null;
  actor: Actor;
  at: string; // ISO-8601
  payload: P;
  idemKey: string | null;
  causationId: string | null;
  correlationId: string | null;
};

export type EventInput<P = unknown> = {
  stream: string;
  type: string;
  payload: P;
  actor: Actor;
  idemKey?: string;
  causationId?: string;
  correlationId?: string;
  at?: string;
} & Scope;

/** Minimal SQL surface. A real pg Pool, a pg tx, and PGlite all satisfy this. */
export interface Queryable {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  tx<T>(fn: (t: Queryable) => Promise<T>): Promise<T>;
}

export class KernelError extends Error {
  code: string;
  details: Record<string, unknown>;
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "KernelError";
    this.code = code;
    this.details = details;
  }
}

export class UnknownEventType extends KernelError {
  constructor(type: string) {
    super("UNKNOWN_EVENT_TYPE", `Event type "${type}" is not registered`, { type });
  }
}

export class InvalidEventPayload extends KernelError {
  constructor(type: string, issues: unknown) {
    super("INVALID_EVENT_PAYLOAD", `Payload for "${type}" failed validation`, { type, issues });
  }
}

export class SupersededEventType extends KernelError {
  constructor(type: string, supersededBy: string) {
    super(
      "SUPERSEDED_EVENT_TYPE",
      `Event type "${type}" is superseded by "${supersededBy}" and is read-only`,
      { type, supersededBy },
    );
  }
}

export class DuplicateEvent extends KernelError {
  constructor(stream: string, idemKey: string) {
    super("DUPLICATE_EVENT", `Event with idemKey "${idemKey}" already exists on "${stream}"`, {
      stream,
      idemKey,
    });
  }
}

export class AmbiguousStep extends KernelError {
  constructor(runId: string, stepKey: string) {
    super(
      "AMBIGUOUS_STEP",
      `Non-idempotent step "${stepKey}" was interrupted after starting; cannot safely retry`,
      { runId, stepKey },
    );
  }
}
