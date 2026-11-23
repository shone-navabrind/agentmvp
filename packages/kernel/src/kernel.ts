import { randomBytes } from "node:crypto";
import type { Db } from "./types.ts";
import { migrate } from "./migrations.ts";
import { SchemaRegistry } from "./registry.ts";
import { EventLog } from "./log.ts";
import { ProjectionRunner } from "./projections.ts";
import { StepRuntime } from "./steps.ts";
import { Authz } from "./authz.ts";
import type { Decision, Resource, Subject } from "./authz.ts";
import { LocalMasterKey, Secrets, type KeyWrapper } from "./secrets.ts";

export type Kernel = {
  db: Db;
  registry: SchemaRegistry;
  log: EventLog;
  projections: ProjectionRunner;
  steps: StepRuntime;
  authz: Authz;
  secrets: Secrets;
};

export type KernelOptions = {
  keyWrapper?: KeyWrapper;
  leaseMs?: number;
  /** Receives every authorization decision -- wire this to the audit log in production. */
  onDecision?: (d: Decision, s: Subject, r: Resource) => void;
};

/**
 * Wires the five kernel concerns together. This is Tier 0: fixed, not pluggable.
 * Everything else in the platform is built on top of exactly this surface.
 */
export async function createKernel(db: Db, opts: KernelOptions = {}): Promise<Kernel> {
  await migrate(db);
  const registry = new SchemaRegistry();
  const log = new EventLog(db, registry);
  return {
    db,
    registry,
    log,
    projections: new ProjectionRunner(db, log),
    steps: new StepRuntime(db, log, { leaseMs: opts.leaseMs }),
    authz: new Authz({ onDecision: opts.onDecision }),
    secrets: new Secrets(db, opts.keyWrapper ?? new LocalMasterKey(randomBytes(32))),
  };
}
