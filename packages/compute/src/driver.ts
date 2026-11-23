import { KernelError } from "@harness/kernel";

export type IsolationLevel = "host" | "container" | "microvm" | "vm";

/** Ranked weakest to strongest; a policy minimum is satisfied by anything at or above it. */
export const ISOLATION_RANK: Record<IsolationLevel, number> = {
  host: 0,
  container: 1,
  microvm: 2,
  vm: 3,
};

export type ComputeCapabilities = {
  isolation: IsolationLevel;
  snapshot: boolean;
  restore: boolean;
  resize: boolean;
  pause: boolean;
  /** Can run Docker inside the sandbox. */
  nested: boolean;
  gpu: boolean;
  bootP50Ms: number;
  maxSessions: number;
};

export type SandboxSize = { vcpu: number; memMiB: number; diskGiB: number };

export type SandboxSpec = {
  projectId: string;
  imageVersion: string;
  size: SandboxSize;
  enrollmentToken: string;
  /** What the project needs; drivers that cannot satisfy these are filtered out. */
  requires?: {
    minIsolation?: IsolationLevel;
    snapshot?: boolean;
    nested?: boolean;
    gpu?: boolean;
  };
};

export type SandboxRef = { driver: string; id: string; hostId?: string };

export type Placement = {
  driver: string;
  hostId: string;
  /** Cost per hour in USD micro-units, used to rank otherwise-equal candidates. */
  costMicrosPerHour: number;
};

export type Unschedulable = { unschedulable: true; reason: string };

export function isUnschedulable(x: Placement | Unschedulable): x is Unschedulable {
  return (x as Unschedulable).unschedulable === true;
}

export interface ComputeDriver {
  readonly id: string;
  capabilities(): ComputeCapabilities;
  plan(spec: SandboxSpec): Promise<Placement | Unschedulable>;
  create(spec: SandboxSpec, placement: Placement): Promise<SandboxRef>;
  start(ref: SandboxRef): Promise<void>;
  stop(ref: SandboxRef): Promise<void>;
  destroy(ref: SandboxRef): Promise<void>;
  state(ref: SandboxRef): Promise<"running" | "stopped" | "gone">;
  metrics(ref: SandboxRef): Promise<{ cpuPct: number; memMiB: number; diskGiB: number }>;
  snapshot?(ref: SandboxRef, name: string): Promise<void>;
  restore?(ref: SandboxRef, name: string): Promise<void>;
  resize?(ref: SandboxRef, size: SandboxSize): Promise<void>;
}

export class NoCapableDriver extends KernelError {
  constructor(reasons: Record<string, string>) {
    super(
      "NO_CAPABLE_DRIVER",
      `No compute driver satisfies this project's requirements`,
      { reasons },
      false,
    );
  }
}

/**
 * Capability negotiation, not lowest-common-denominator. A project declares what it needs;
 * drivers that cannot provide it are excluded with a stated reason, so the UI can say
 * "snapshots are unavailable on this host" instead of silently degrading.
 */
export function filterCapable(
  drivers: ComputeDriver[],
  requires: SandboxSpec["requires"] = {},
): { capable: ComputeDriver[]; rejected: Record<string, string> } {
  const capable: ComputeDriver[] = [];
  const rejected: Record<string, string> = {};

  for (const d of drivers) {
    const c = d.capabilities();
    if (
      requires.minIsolation &&
      ISOLATION_RANK[c.isolation] < ISOLATION_RANK[requires.minIsolation]
    ) {
      rejected[d.id] = `isolation "${c.isolation}" is weaker than required "${requires.minIsolation}"`;
      continue;
    }
    if (requires.snapshot && !c.snapshot) {
      rejected[d.id] = "does not support snapshots";
      continue;
    }
    if (requires.nested && !c.nested) {
      rejected[d.id] = "cannot run Docker inside the sandbox";
      continue;
    }
    if (requires.gpu && !c.gpu) {
      rejected[d.id] = "has no GPU";
      continue;
    }
    capable.push(d);
  }
  return { capable, rejected };
}
