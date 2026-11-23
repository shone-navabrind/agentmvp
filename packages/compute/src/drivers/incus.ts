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

export type Exec = (
  argv: string[],
) => Promise<{ code: number; stdout: string; stderr: string }>;

/**
 * Command construction is a pure function so it can be unit-tested without Incus present.
 * Getting these flags wrong is the difference between a booting VM and a silent failure,
 * and CI has no KVM -- so the argv is what we assert on.
 */
export const incusArgv = {
  launch(spec: SandboxSpec, name: string, hostId: string): string[] {
    return [
      "incus",
      "launch",
      `harness-base/${spec.imageVersion}`,
      name,
      "--vm", // a real VM, not a system container: the VM is the security boundary
      "--target",
      hostId,
      "--config",
      `limits.cpu=${spec.size.vcpu}`,
      "--config",
      `limits.memory=${spec.size.memMiB}MiB`,
      "--config",
      // Delivered via cloud-init; sandboxd exchanges it for an mTLS client certificate.
      `cloud-init.user-data=#cloud-config\nwrite_files:\n  - path: /etc/harness/enrollment-token\n    permissions: '0600'\n    content: ${spec.enrollmentToken}\n`,
      "--device",
      `root,size=${spec.size.diskGiB}GiB`,
    ];
  },
  stop(name: string): string[] {
    return ["incus", "stop", name, "--force", "--timeout", "30"];
  },
  start(name: string): string[] {
    return ["incus", "start", name];
  },
  destroy(name: string): string[] {
    return ["incus", "delete", name, "--force"];
  },
  snapshot(name: string, snap: string): string[] {
    return ["incus", "snapshot", "create", name, snap];
  },
  restore(name: string, snap: string): string[] {
    return ["incus", "snapshot", "restore", name, snap];
  },
  resize(name: string, size: SandboxSize): string[] {
    return [
      "incus",
      "config",
      "set",
      name,
      `limits.cpu=${size.vcpu}`,
      `limits.memory=${size.memMiB}MiB`,
    ];
  },
  state(name: string): string[] {
    return ["incus", "list", name, "--format", "json"];
  },
};

/**
 * Real VM isolation via Incus. Not exercised in CI: there is no KVM in the build
 * container, so only incusArgv is covered by tests. Integration runs on a KVM runner.
 */
export class IncusDriver implements ComputeDriver {
  readonly id = "incus";
  #exec: Exec;
  #pool: HostPool;

  constructor(opts: { exec: Exec; pool: HostPool }) {
    this.#exec = opts.exec;
    this.#pool = opts.pool;
  }

  capabilities(): ComputeCapabilities {
    return {
      isolation: "vm",
      snapshot: true,
      restore: true,
      resize: true,
      pause: true,
      nested: true,
      gpu: false,
      bootP50Ms: 18_000,
      maxSessions: 8,
    };
  }

  async plan(spec: SandboxSpec): Promise<Placement | Unschedulable> {
    const hostId = this.#pool.pick(spec.size);
    if (!hostId) {
      return {
        unschedulable: true,
        reason: `no Incus host has ${spec.size.vcpu} vCPU / ${spec.size.memMiB} MiB free`,
      };
    }
    return { driver: this.id, hostId, costMicrosPerHour: 0 };
  }

  async #run(argv: string[]): Promise<string> {
    const r = await this.#exec(argv);
    if (r.code !== 0) throw new Error(`${argv.slice(0, 2).join(" ")} failed: ${r.stderr.trim()}`);
    return r.stdout;
  }

  async create(spec: SandboxSpec, placement: Placement): Promise<SandboxRef> {
    const name = `sbx-${spec.projectId}-${Date.now().toString(36)}`;
    this.#pool.allocate(placement.hostId, name, spec.size);
    try {
      await this.#run(incusArgv.launch(spec, name, placement.hostId));
    } catch (err) {
      this.#pool.release(placement.hostId, name);
      throw err;
    }
    return { driver: this.id, id: name, hostId: placement.hostId };
  }

  async start(ref: SandboxRef): Promise<void> {
    await this.#run(incusArgv.start(ref.id));
  }
  async stop(ref: SandboxRef): Promise<void> {
    await this.#run(incusArgv.stop(ref.id));
  }
  async destroy(ref: SandboxRef): Promise<void> {
    await this.#run(incusArgv.destroy(ref.id));
    if (ref.hostId) this.#pool.release(ref.hostId, ref.id);
  }
  async snapshot(ref: SandboxRef, name: string): Promise<void> {
    await this.#run(incusArgv.snapshot(ref.id, name));
  }
  async restore(ref: SandboxRef, name: string): Promise<void> {
    await this.#run(incusArgv.restore(ref.id, name));
  }
  async resize(ref: SandboxRef, size: SandboxSize): Promise<void> {
    await this.#run(incusArgv.resize(ref.id, size));
  }

  async state(ref: SandboxRef): Promise<"running" | "stopped" | "gone"> {
    try {
      const out = await this.#run(incusArgv.state(ref.id));
      const list = JSON.parse(out) as Array<{ name: string; status: string }>;
      const row = list.find((x) => x.name === ref.id);
      if (!row) return "gone";
      return row.status === "Running" ? "running" : "stopped";
    } catch {
      return "gone";
    }
  }

  async metrics(ref: SandboxRef): Promise<{ cpuPct: number; memMiB: number; diskGiB: number }> {
    const out = await this.#run(["incus", "info", ref.id, "--format", "json"]);
    const info = JSON.parse(out) as {
      state?: { cpu?: { usage?: number }; memory?: { usage?: number }; disk?: Record<string, { usage?: number }> };
    };
    return {
      cpuPct: 0,
      memMiB: Math.round((info.state?.memory?.usage ?? 0) / 1024 / 1024),
      diskGiB: Math.round((info.state?.disk?.root?.usage ?? 0) / 1024 / 1024 / 1024),
    };
  }
}
