import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ComputeCapabilities,
  ComputeDriver,
  Placement,
  SandboxRef,
  SandboxSize,
  SandboxSpec,
  Unschedulable,
} from "../driver.ts";
import type { HostPool } from "../host-pool.ts";

/**
 * Carves the host's own filesystem into sandbox directories. Isolation is "host", which
 * is honest: this is the dev/CI driver, and policy must refuse it for untrusted tenants.
 * It exists so the whole stack above the driver interface can be exercised without KVM.
 */
export class LocalProcessDriver implements ComputeDriver {
  readonly id = "local-process";
  #root: string;
  #pool: HostPool;
  #hostId: string;
  #states = new Map<string, "running" | "stopped" | "gone">();

  constructor(opts: { root: string; pool: HostPool; hostId: string }) {
    this.#root = opts.root;
    this.#pool = opts.pool;
    this.#hostId = opts.hostId;
  }

  capabilities(): ComputeCapabilities {
    return {
      isolation: "host",
      snapshot: false,
      restore: false,
      resize: true,
      pause: false,
      nested: false,
      gpu: false,
      bootP50Ms: 50,
      maxSessions: 8,
    };
  }

  async plan(spec: SandboxSpec): Promise<Placement | Unschedulable> {
    if (!this.#pool.fits(this.#hostId, spec.size)) {
      const f = this.#pool.free(this.#hostId);
      return {
        unschedulable: true,
        reason: `host "${this.#hostId}" has ${f.vcpu} vCPU / ${f.memMiB} MiB free`,
      };
    }
    return { driver: this.id, hostId: this.#hostId, costMicrosPerHour: 0 };
  }

  async create(spec: SandboxSpec, placement: Placement): Promise<SandboxRef> {
    const id = `sbx-${spec.projectId}-${Math.random().toString(36).slice(2, 8)}`;
    this.#pool.allocate(placement.hostId, id, spec.size);
    const dir = join(this.#root, id);
    await mkdir(join(dir, "workspace"), { recursive: true });
    await mkdir(join(dir, "git"), { recursive: true });
    await writeFile(
      join(dir, "sandbox.json"),
      JSON.stringify({ id, spec: { ...spec, enrollmentToken: "<redacted>" } }, null, 2),
    );
    this.#states.set(id, "running");
    return { driver: this.id, id, hostId: placement.hostId };
  }

  async start(ref: SandboxRef): Promise<void> {
    this.#states.set(ref.id, "running");
  }

  async stop(ref: SandboxRef): Promise<void> {
    this.#states.set(ref.id, "stopped");
  }

  async destroy(ref: SandboxRef): Promise<void> {
    await rm(join(this.#root, ref.id), { recursive: true, force: true });
    if (ref.hostId) this.#pool.release(ref.hostId, ref.id);
    this.#states.set(ref.id, "gone");
  }

  async state(ref: SandboxRef): Promise<"running" | "stopped" | "gone"> {
    return this.#states.get(ref.id) ?? "gone";
  }

  async metrics(ref: SandboxRef): Promise<{ cpuPct: number; memMiB: number; diskGiB: number }> {
    try {
      await stat(join(this.#root, ref.id));
      return { cpuPct: 0, memMiB: 0, diskGiB: 0 };
    } catch {
      return { cpuPct: 0, memMiB: 0, diskGiB: 0 };
    }
  }

  async resize(_ref: SandboxRef, _size: SandboxSize): Promise<void> {
    /* directories have no size limit here */
  }

  dirFor(ref: SandboxRef): string {
    return join(this.#root, ref.id);
  }
}
