import type {
  ComputeDriver,
  Placement,
  SandboxRef,
  SandboxSpec,
} from "./driver.ts";
import { filterCapable, isUnschedulable, NoCapableDriver } from "./driver.ts";

export type SchedulerDecision = {
  ref: SandboxRef;
  driver: string;
  placement: Placement;
  fromWarmPool: boolean;
  tookMs: number;
};

export type WarmEntry = { ref: SandboxRef; imageVersion: string; driver: string };

/**
 * Picks a driver by capability, then by cost and boot time, and prefers a pre-booted
 * sandbox when one matches. Assigning a warm sandbox turns "create project" from a
 * minute into a few seconds, which is the difference between a demo and a product.
 */
export class Scheduler {
  #drivers: ComputeDriver[];
  #warm: WarmEntry[] = [];
  #targetWarm: number;
  #now: () => number;

  constructor(opts: { drivers: ComputeDriver[]; targetWarm?: number; now?: () => number }) {
    this.#drivers = opts.drivers;
    this.#targetWarm = opts.targetWarm ?? 0;
    this.#now = opts.now ?? Date.now;
  }

  driver(id: string): ComputeDriver | undefined {
    return this.#drivers.find((d) => d.id === id);
  }

  warmCount(imageVersion?: string): number {
    return this.#warm.filter((w) => !imageVersion || w.imageVersion === imageVersion).length;
  }

  /** Top the warm pool back up. Returns how many were booted. */
  async refillWarmPool(spec: Omit<SandboxSpec, "projectId">): Promise<number> {
    let booted = 0;
    while (this.warmCount(spec.imageVersion) < this.#targetWarm) {
      const full: SandboxSpec = { ...spec, projectId: "__warm__" };
      const chosen = await this.#choose(full);
      const ref = await chosen.driver.create(full, chosen.placement);
      this.#warm.push({ ref, imageVersion: spec.imageVersion, driver: chosen.driver.id });
      booted++;
    }
    return booted;
  }

  async #choose(spec: SandboxSpec): Promise<{ driver: ComputeDriver; placement: Placement }> {
    const { capable, rejected } = filterCapable(this.#drivers, spec.requires);
    if (capable.length === 0) throw new NoCapableDriver(rejected);

    const candidates: Array<{ driver: ComputeDriver; placement: Placement }> = [];
    for (const d of capable) {
      const p = await d.plan(spec);
      if (isUnschedulable(p)) {
        rejected[d.id] = p.reason;
        continue;
      }
      candidates.push({ driver: d, placement: p });
    }
    if (candidates.length === 0) throw new NoCapableDriver(rejected);

    candidates.sort((a, b) => {
      const cost = a.placement.costMicrosPerHour - b.placement.costMicrosPerHour;
      if (cost !== 0) return cost;
      return a.driver.capabilities().bootP50Ms - b.driver.capabilities().bootP50Ms;
    });
    return candidates[0];
  }

  async acquire(spec: SandboxSpec): Promise<SchedulerDecision> {
    const started = this.#now();

    const warmIdx = this.#warm.findIndex((w) => {
      if (w.imageVersion !== spec.imageVersion) return false;
      const d = this.driver(w.driver);
      if (!d) return false;
      const { capable } = filterCapable([d], spec.requires);
      return capable.length === 1;
    });

    if (warmIdx >= 0) {
      const [entry] = this.#warm.splice(warmIdx, 1);
      return {
        ref: entry.ref,
        driver: entry.driver,
        placement: {
          driver: entry.driver,
          hostId: entry.ref.hostId ?? "unknown",
          costMicrosPerHour: 0,
        },
        fromWarmPool: true,
        tookMs: this.#now() - started,
      };
    }

    const chosen = await this.#choose(spec);
    const ref = await chosen.driver.create(spec, chosen.placement);
    return {
      ref,
      driver: chosen.driver.id,
      placement: chosen.placement,
      fromWarmPool: false,
      tookMs: this.#now() - started,
    };
  }

  async release(ref: SandboxRef): Promise<void> {
    const d = this.driver(ref.driver);
    if (d) await d.destroy(ref);
  }
}
