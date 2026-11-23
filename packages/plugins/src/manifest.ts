import { z } from "zod";
import { KernelError } from "@harness/kernel";

export const EXTENSION_POINTS = [
  "compute.driver",
  "harness.adapter",
  "flow.node",
  "trigger.source",
  "connector.ingress",
  "connector.egress",
  "board.view",
  "board.automation",
  "model.gateway",
  "auth.provider",
  "secrets.backend",
  "storage.backend",
  "ui.panel",
] as const;
export type ExtensionPoint = (typeof EXTENSION_POINTS)[number];

/**
 * Capabilities are declared in the manifest, shown to the admin at install, and enforced
 * at every call. A plugin that did not ask for a capability cannot use it, whatever its
 * code tries. Grammar: "<domain>:<action>[:<scope>]".
 */
export const CAPABILITY_PATTERN = /^[a-z]+:[a-z-]+(?::[A-Za-z0-9_\-/.*]+)?$/;

export const pluginManifest = z.object({
  id: z.string().regex(/^[a-z0-9]+(\.[a-z0-9-]+)+$/, "id must look like 'acme.jira'"),
  version: z.string().regex(/^\d+\.\d+\.\d+/, "version must be semver"),
  /** Host API range this plugin was built against. */
  apiVersion: z.string(),
  runtime: z.enum(["in-process", "worker", "container"]),
  trust: z.enum(["core", "verified", "untrusted"]),
  provides: z
    .array(z.object({ point: z.enum(EXTENSION_POINTS), name: z.string().min(1) }))
    .min(1),
  capabilities: z.array(z.string().regex(CAPABILITY_PATTERN)).default([]),
  config: z.record(z.unknown()).default({}),
  description: z.string().default(""),
});

export type PluginManifest = z.infer<typeof pluginManifest>;

export class ManifestInvalid extends KernelError {
  constructor(issues: unknown) {
    super("PLUGIN_MANIFEST_INVALID", "Plugin manifest failed validation", { issues }, false);
  }
}

export class IncompatibleApiVersion extends KernelError {
  constructor(pluginId: string, want: string, host: string) {
    super(
      "PLUGIN_API_INCOMPATIBLE",
      `Plugin "${pluginId}" needs host API ${want}; this host is ${host}`,
      { pluginId, want, host },
      false,
    );
  }
}

export class CapabilityNotGranted extends KernelError {
  constructor(pluginId: string, capability: string) {
    super(
      "PLUGIN_CAPABILITY_DENIED",
      `Plugin "${pluginId}" did not declare capability "${capability}"`,
      { pluginId, capability },
      false,
    );
  }
}

export class UntrustedInProcess extends KernelError {
  constructor(pluginId: string) {
    super(
      "PLUGIN_UNTRUSTED_IN_PROCESS",
      `Plugin "${pluginId}" is untrusted and may not run in the API process`,
      { pluginId },
      false,
    );
  }
}

export function parseManifest(raw: unknown): PluginManifest {
  const r = pluginManifest.safeParse(raw);
  if (!r.success) throw new ManifestInvalid(r.error.issues);
  return r.data;
}

/** Caret/tilde-free subset: "^1.2" accepts 1.x >= 1.2; "1.2" is exact-minor. */
export function apiCompatible(want: string, host: string): boolean {
  const [hMajor, hMinor] = host.split(".").map(Number);
  if (want.startsWith("^")) {
    const [wMajor, wMinor] = want.slice(1).split(".").map(Number);
    return hMajor === wMajor && hMinor >= (wMinor || 0);
  }
  const [wMajor, wMinor] = want.split(".").map(Number);
  return hMajor === wMajor && hMinor === wMinor;
}

/** Does a declared capability cover a requested one? Supports a trailing "*". */
export function capabilityCovers(declared: string, requested: string): boolean {
  if (declared === requested) return true;
  if (!declared.endsWith("*")) return false;
  return requested.startsWith(declared.slice(0, -1));
}
