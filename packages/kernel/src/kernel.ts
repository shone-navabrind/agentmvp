import type { Db } from "./types.ts";
import { KernelError } from "./types.ts";
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
  /**
   * Required unless `ephemeralSecrets` is set. There is deliberately no default: a
   * generated-per-boot key makes every stored secret undecryptable after a restart,
   * which is silent data loss rather than a visible failure.
   */
  keyWrapper?: KeyWrapper;
  /** Tests and throwaway sandboxes only: mint a key that dies with the process. */
  ephemeralSecrets?: boolean;
  leaseMs?: number;
  /** Receives every authorization decision -- wire this to the audit log in production. */
  onDecision?: (d: Decision, s: Subject, r: Resource) => void;
};

/**
 * Wires the five kernel concerns together. This is Tier 0: fixed, not pluggable.
 * Everything else in the platform is built on top of exactly this surface.
 */
export async function createKernel(db: Db, opts: KernelOptions = {}): Promise<Kernel> {
  if (!opts.keyWrapper && !opts.ephemeralSecrets) {
    throw new KernelError(
      "NO_KEY_WRAPPER",
      "createKernel needs a keyWrapper. Pass one backed by KMS, Vault or a persisted " +
        "master key, or set ephemeralSecrets: true for a throwaway instance. Generating " +
        "one per boot would make every stored secret unreadable after a restart.",
      {},
      false,
    );
  }
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
    secrets: new Secrets(db, opts.keyWrapper ?? LocalMasterKey.ephemeral()),
  };
}
