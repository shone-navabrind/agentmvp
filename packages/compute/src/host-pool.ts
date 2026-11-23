import { KernelError } from "@harness/kernel";
import type { SandboxSize } from "./driver.ts";

export type HostCapacity = { vcpu: number; memMiB: number; diskGiB: number };

export type HostRecord = {
  id: string;
  total: HostCapacity;
  /** Held back for the control plane and the OS; never allocatable. */
  reserved: HostCapacity;
  /** Overcommit ratio per resource. CPU is routinely overcommitted; disk never should be. */
  overcommit: { vcpu: number; memMiB: number; diskGiB: number };
};

export class OutOfCapacity extends KernelError {
  constructor(hostId: string, want: SandboxSize, free: HostCapacity) {
    super(
      "OUT_OF_CAPACITY",
      `Host "${hostId}" cannot fit ${want.vcpu} vCPU / ${want.memMiB} MiB / ${want.diskGiB} GiB`,
      { hostId, want, free },
      false,
    );
  }
}

/**
 * Splits a host's own spec into sandbox slices. Refuses placement rather than thrashing:
 * silently oversubscribing memory is what gets agents OOM-killed once Docker is running.
 */
export class HostPool {
  #hosts = new Map<string, HostRecord>();
  #allocations = new Map<string, Map<string, SandboxSize>>();

  addHost(h: HostRecord): this {
    this.#hosts.set(h.id, h);
    this.#allocations.set(h.id, new Map());
    return this;
  }

  hosts(): HostRecord[] {
    return [...this.#hosts.values()];
  }

  allocatable(hostId: string): HostCapacity {
    const h = this.#hosts.get(hostId);
    if (!h) throw new Error(`no such host "${hostId}"`);
    return {
      vcpu: Math.floor((h.total.vcpu - h.reserved.vcpu) * h.overcommit.vcpu),
      memMiB: Math.floor((h.total.memMiB - h.reserved.memMiB) * h.overcommit.memMiB),
      diskGiB: Math.floor((h.total.diskGiB - h.reserved.diskGiB) * h.overcommit.diskGiB),
    };
  }

  used(hostId: string): HostCapacity {
    const allocs = this.#allocations.get(hostId) ?? new Map();
    let vcpu = 0;
    let memMiB = 0;
    let diskGiB = 0;
    for (const s of allocs.values()) {
      vcpu += s.vcpu;
      memMiB += s.memMiB;
      diskGiB += s.diskGiB;
    }
    return { vcpu, memMiB, diskGiB };
  }

  free(hostId: string): HostCapacity {
    const a = this.allocatable(hostId);
    const u = this.used(hostId);
    return { vcpu: a.vcpu - u.vcpu, memMiB: a.memMiB - u.memMiB, diskGiB: a.diskGiB - u.diskGiB };
  }

  fits(hostId: string, size: SandboxSize): boolean {
    const f = this.free(hostId);
    return f.vcpu >= size.vcpu && f.memMiB >= size.memMiB && f.diskGiB >= size.diskGiB;
  }

  /** Best-fit: the host with the least leftover memory that still fits. Packs tightly. */
  pick(size: SandboxSize): string | null {
    let best: { id: string; slack: number } | null = null;
    for (const h of this.#hosts.values()) {
      if (!this.fits(h.id, size)) continue;
      const slack = this.free(h.id).memMiB - size.memMiB;
      if (!best || slack < best.slack) best = { id: h.id, slack };
    }
    return best?.id ?? null;
  }

  allocate(hostId: string, sandboxId: string, size: SandboxSize): void {
    if (!this.fits(hostId, size)) throw new OutOfCapacity(hostId, size, this.free(hostId));
    this.#allocations.get(hostId)!.set(sandboxId, size);
  }

  release(hostId: string, sandboxId: string): void {
    this.#allocations.get(hostId)?.delete(sandboxId);
  }

  allocationsOn(hostId: string): string[] {
    return [...(this.#allocations.get(hostId)?.keys() ?? [])];
  }
}
