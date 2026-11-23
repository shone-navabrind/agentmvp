import { KernelError } from "@harness/kernel";
import {
  apiCompatible,
  capabilityCovers,
  CapabilityNotGranted,
  IncompatibleApiVersion,
  UntrustedInProcess,
  type ExtensionPoint,
  type PluginManifest,
} from "./manifest.ts";

/** The only surface a plugin gets. Never the DB handle, never the Drizzle client. */
export type PlatformAPI = {
  pluginId: string;
  /** Throws unless the manifest declared a capability covering this one. */
  require(capability: string): void;
  emit(type: string, payload: unknown): Promise<void>;
  secret(uri: string): Promise<string>;
  fetch(url: string, init?: RequestInit): Promise<Response>;
  log(level: "info" | "warn" | "error", msg: string, meta?: unknown): void;
};

export type PluginModule = {
  manifest: PluginManifest;
  /** Called once at load. Returns the implementations this plugin provides. */
  activate(api: PlatformAPI): Promise<Record<string, unknown>> | Record<string, unknown>;
  deactivate?(): Promise<void> | void;
};

export type LoadedPlugin = {
  manifest: PluginManifest;
  exports: Record<string, unknown>;
  state: "active" | "disabled";
  failures: number;
  lastError?: string;
};

export class PluginCallFailed extends KernelError {
  constructor(pluginId: string, name: string, cause: string) {
    super("PLUGIN_CALL_FAILED", `Plugin "${pluginId}" extension "${name}" failed: ${cause}`, {
      pluginId,
      name,
      cause,
    });
  }
}

export class CircuitOpen extends KernelError {
  constructor(pluginId: string, failures: number) {
    super(
      "PLUGIN_CIRCUIT_OPEN",
      `Plugin "${pluginId}" was disabled after ${failures} consecutive failures`,
      { pluginId, failures },
      false,
    );
  }
}

export type HostOptions = {
  apiVersion: string;
  emit: (pluginId: string, type: string, payload: unknown) => Promise<void>;
  secret: (pluginId: string, uri: string) => Promise<string>;
  fetch?: typeof fetch;
  /** Disable a plugin after this many consecutive failures. */
  failureThreshold?: number;
  /** Wall-clock budget for one extension call. */
  callTimeoutMs?: number;
  onLog?: (pluginId: string, level: string, msg: string, meta?: unknown) => void;
};

/**
 * Loads and supervises plugins.
 *
 * Three rules keep "everything is pluggable" from meaning "one bad plugin takes down the
 * control plane": an untrusted plugin may not run in-process, every call is time-boxed,
 * and a plugin that keeps failing is circuit-broken rather than retried forever.
 */
export class PluginHost {
  #opts: Required<Pick<HostOptions, "apiVersion" | "failureThreshold" | "callTimeoutMs">> &
    HostOptions;
  #plugins = new Map<string, LoadedPlugin>();

  constructor(opts: HostOptions) {
    this.#opts = {
      failureThreshold: 3,
      callTimeoutMs: 5_000,
      ...opts,
    };
  }

  #api(manifest: PluginManifest): PlatformAPI {
    const host = this;
    const declared = manifest.capabilities;
    return {
      pluginId: manifest.id,
      require(capability: string) {
        if (!declared.some((d) => capabilityCovers(d, capability))) {
          throw new CapabilityNotGranted(manifest.id, capability);
        }
      },
      async emit(type, payload) {
        this.require(`events:write:${type}`);
        await host.#opts.emit(manifest.id, type, payload);
      },
      async secret(uri) {
        this.require(`secret:read:${uri.replace(/^secret:\/\//, "")}`);
        return host.#opts.secret(manifest.id, uri);
      },
      async fetch(url, init) {
        const h = new URL(url).hostname;
        this.require(`http:egress:${h}`);
        return (host.#opts.fetch ?? fetch)(url, init);
      },
      log(level, msg, meta) {
        host.#opts.onLog?.(manifest.id, level, msg, meta);
      },
    };
  }

  async load(mod: PluginModule): Promise<LoadedPlugin> {
    const m = mod.manifest;
    if (!apiCompatible(m.apiVersion, this.#opts.apiVersion)) {
      // Refuse at load rather than crash at the first call.
      throw new IncompatibleApiVersion(m.id, m.apiVersion, this.#opts.apiVersion);
    }
    if (m.trust === "untrusted" && m.runtime === "in-process") {
      throw new UntrustedInProcess(m.id);
    }
    const exports = await mod.activate(this.#api(m));

    const declaredNames = new Set(m.provides.map((p) => p.name));
    for (const name of Object.keys(exports)) {
      if (!declaredNames.has(name)) {
        throw new KernelError(
          "PLUGIN_UNDECLARED_EXPORT",
          `Plugin "${m.id}" exports "${name}", which its manifest does not declare`,
          { pluginId: m.id, name },
          false,
        );
      }
    }

    const loaded: LoadedPlugin = { manifest: m, exports, state: "active", failures: 0 };
    this.#plugins.set(m.id, loaded);
    return loaded;
  }

  list(): LoadedPlugin[] {
    return [...this.#plugins.values()].sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
  }

  get(id: string): LoadedPlugin | undefined {
    return this.#plugins.get(id);
  }

  /** Every active implementation bound to an extension point. */
  implementations(point: ExtensionPoint): Array<{ pluginId: string; name: string; impl: unknown }> {
    const out: Array<{ pluginId: string; name: string; impl: unknown }> = [];
    for (const p of this.#plugins.values()) {
      if (p.state !== "active") continue;
      for (const binding of p.manifest.provides) {
        if (binding.point !== point) continue;
        out.push({ pluginId: p.manifest.id, name: binding.name, impl: p.exports[binding.name] });
      }
    }
    return out;
  }

  /**
   * Invoke an extension with a timeout and a circuit breaker. A plugin that throws or
   * hangs degrades itself; it never cascades into the host.
   */
  async call<T>(pluginId: string, name: string, fn: (impl: unknown) => Promise<T>): Promise<T> {
    const p = this.#plugins.get(pluginId);
    if (!p) throw new KernelError("NO_SUCH_PLUGIN", `No plugin "${pluginId}"`, { pluginId }, false);
    if (p.state === "disabled") throw new CircuitOpen(pluginId, p.failures);

    const impl = p.exports[name];
    if (impl === undefined) {
      throw new KernelError("NO_SUCH_EXTENSION", `Plugin "${pluginId}" has no "${name}"`, {}, false);
    }

    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        fn(impl),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`timed out after ${this.#opts.callTimeoutMs}ms`)),
            this.#opts.callTimeoutMs,
          );
        }),
      ]);
      p.failures = 0;
      return result;
    } catch (err) {
      p.failures++;
      p.lastError = err instanceof Error ? err.message : String(err);
      if (p.failures >= this.#opts.failureThreshold) p.state = "disabled";
      throw new PluginCallFailed(pluginId, name, p.lastError);
    } finally {
      clearTimeout(timer);
    }
  }

  /** An admin re-enabling a circuit-broken plugin after fixing its config. */
  reset(pluginId: string): void {
    const p = this.#plugins.get(pluginId);
    if (!p) return;
    p.failures = 0;
    p.state = "active";
    p.lastError = undefined;
  }

  async unload(pluginId: string): Promise<void> {
    this.#plugins.delete(pluginId);
  }
}
