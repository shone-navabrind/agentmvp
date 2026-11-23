import { KernelError } from "@harness/kernel";

export type SessionState =
  | "queued"
  | "starting"
  | "active"
  | "idle"
  | "suspended"
  | "archived";

export type SessionRecord = {
  id: string;
  projectId: string;
  state: SessionState;
  branch: string;
  portRange: { from: number; to: number };
  cgroupScope: string;
  memMiB: number;
  cpuWeight: number;
  lastActiveAt: number;
};

export type SandboxSize = { vcpu: number; memMiB: number };

export class AtCapacity extends KernelError {
  constructor(active: number, max: number) {
    super(
      "SANDBOX_AT_CAPACITY",
      `Sandbox is running ${active} of a maximum ${max} sessions`,
      { active, max },
      false,
    );
  }
}

/**
 * Admission control for sessions sharing one sandbox.
 *
 * Reserves headroom for the OS and sandboxd, then caps concurrency by whichever of
 * memory or CPU binds first. Queueing visibly beats oversubscribing silently: the
 * prototype's agents were OOM-killed because nothing refused the extra work.
 */
export function maxSessionsFor(
  size: SandboxSize,
  opts: { perSessionMemMiB?: number; reserveMemMiB?: number; driverMax?: number } = {},
): number {
  const perSession = opts.perSessionMemMiB ?? 512;
  const reserve = opts.reserveMemMiB ?? 768;
  const byMem = Math.floor((size.memMiB - reserve) / perSession);
  const byCpu = size.vcpu * 2;
  return Math.max(0, Math.min(byMem, byCpu, opts.driverMax ?? Number.MAX_SAFE_INTEGER));
}

const PORT_BLOCK = 10;

export class SessionManager {
  #sessions = new Map<string, SessionRecord>();
  #max: number;
  #basePort: number;
  #perSessionMemMiB: number;
  #now: () => number;

  constructor(opts: {
    size: SandboxSize;
    driverMax?: number;
    basePort?: number;
    perSessionMemMiB?: number;
    now?: () => number;
  }) {
    this.#perSessionMemMiB = opts.perSessionMemMiB ?? 512;
    this.#max = maxSessionsFor(opts.size, {
      perSessionMemMiB: this.#perSessionMemMiB,
      driverMax: opts.driverMax,
    });
    this.#basePort = opts.basePort ?? 40000;
    this.#now = opts.now ?? Date.now;
  }

  get maxSessions(): number {
    return this.#max;
  }

  /** Sessions occupying a slot. Suspended and archived sessions release theirs. */
  activeCount(): number {
    return [...this.#sessions.values()].filter(
      (s) => s.state === "starting" || s.state === "active" || s.state === "idle",
    ).length;
  }

  list(): SessionRecord[] {
    return [...this.#sessions.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id: string): SessionRecord | undefined {
    return this.#sessions.get(id);
  }

  #allocatePorts(): { from: number; to: number } {
    const taken = new Set(
      [...this.#sessions.values()]
        .filter((s) => s.state !== "archived")
        .map((s) => s.portRange.from),
    );
    for (let i = 0; i < 1000; i++) {
      const from = this.#basePort + i * PORT_BLOCK;
      if (!taken.has(from)) return { from, to: from + PORT_BLOCK - 1 };
    }
    throw new Error("no free port block");
  }

  /**
   * Admit a session, or queue it. A queued session holds no resources and is visible
   * to the UI as "waiting for capacity", with a "resize sandbox" affordance.
   */
  admit(id: string, projectId: string, opts: { force?: boolean } = {}): SessionRecord {
    if (this.#sessions.has(id)) throw new Error(`session "${id}" already exists`);
    const atCapacity = this.activeCount() >= this.#max;
    if (atCapacity && opts.force) throw new AtCapacity(this.activeCount(), this.#max);

    const rec: SessionRecord = {
      id,
      projectId,
      state: atCapacity ? "queued" : "starting",
      branch: `session/${id}`,
      portRange: this.#allocatePorts(),
      cgroupScope: `hc-session-${id}.scope`,
      memMiB: this.#perSessionMemMiB,
      cpuWeight: 100,
      lastActiveAt: this.#now(),
    };
    this.#sessions.set(id, rec);
    return rec;
  }

  transition(id: string, state: SessionState): SessionRecord {
    const s = this.#sessions.get(id);
    if (!s) throw new Error(`no such session "${id}"`);
    s.state = state;
    s.lastActiveAt = this.#now();
    if (state === "active" || state === "idle") this.#promoteQueued();
    return s;
  }

  /** Free a slot: suspend or archive. The next queued session starts automatically. */
  suspend(id: string): SessionRecord {
    const s = this.transition(id, "suspended");
    this.#promoteQueued();
    return s;
  }

  archive(id: string): SessionRecord {
    const s = this.transition(id, "archived");
    this.#promoteQueued();
    return s;
  }

  #promoteQueued(): void {
    while (this.activeCount() < this.#max) {
      const next = [...this.#sessions.values()].find((s) => s.state === "queued");
      if (!next) return;
      next.state = "starting";
      next.lastActiveAt = this.#now();
    }
  }

  /** Sessions idle longer than the policy allows, for the reaper. */
  idleLongerThan(ms: number): SessionRecord[] {
    const cutoff = this.#now() - ms;
    return this.list().filter(
      (s) => (s.state === "idle" || s.state === "active") && s.lastActiveAt < cutoff,
    );
  }

  /**
   * The systemd scope a session's processes run in. One cgroup per session is what stops
   * a runaway build in one session starving its neighbours.
   */
  systemdRunArgs(id: string, argv: string[]): string[] {
    const s = this.#sessions.get(id);
    if (!s) throw new Error(`no such session "${id}"`);
    return [
      "systemd-run",
      "--scope",
      `--unit=${s.cgroupScope}`,
      `--property=MemoryMax=${s.memMiB}M`,
      `--property=MemoryHigh=${Math.floor(s.memMiB * 0.9)}M`,
      `--property=CPUWeight=${s.cpuWeight}`,
      "--property=TasksMax=512",
      "--property=IOWeight=100",
      "--",
      ...argv,
    ];
  }
}
