import type { ActorKind } from "./types.ts";
import { KernelError } from "./types.ts";

/** Capabilities live in a closed registry. An unregistered string is an error, not a deny. */
export type Capability = string;

export type ScopeKind = "tenant" | "workspace" | "project";

export type Assignment = {
  /** A named role, or a single capability granted directly. */
  role?: string;
  capability?: Capability;
  scope: ScopeKind;
  scopeId: string;
};

export type Subject = {
  kind: ActorKind;
  id: string;
  assignments: Assignment[];
};

export type Resource = {
  tenantId: string;
  workspaceId?: string;
  projectId?: string;
};

export type Decision = {
  allowed: boolean;
  reason: string;
  capability: Capability;
  via?: Assignment;
};

export class UnknownCapability extends KernelError {
  constructor(capability: string) {
    super("UNKNOWN_CAPABILITY", `Capability "${capability}" is not registered`, { capability });
  }
}

function covers(a: Assignment, r: Resource): boolean {
  if (a.scope === "tenant") return a.scopeId === r.tenantId;
  if (a.scope === "workspace") return a.scopeId === r.workspaceId;
  return a.scopeId === r.projectId;
}

/**
 * One authorization module. Every API handler, WebSocket upgrade, MCP tool, flow node and
 * plugin call goes through can(). There are no ad-hoc role checks anywhere else -- the
 * subject may be a user, an agent session, a flow run or a plugin, and all four are checked
 * the same way.
 */
export class Authz {
  #caps = new Set<Capability>();
  #roles = new Map<string, Set<Capability>>();
  #onDecision?: (d: Decision, s: Subject, r: Resource) => void;

  constructor(opts: { onDecision?: (d: Decision, s: Subject, r: Resource) => void } = {}) {
    this.#onDecision = opts.onDecision;
  }

  defineCapability(...caps: Capability[]): this {
    for (const c of caps) this.#caps.add(c);
    return this;
  }

  defineRole(name: string, caps: Capability[]): this {
    for (const c of caps) if (!this.#caps.has(c)) throw new UnknownCapability(c);
    this.#roles.set(name, new Set(caps));
    return this;
  }

  capabilitiesOf(role: string): Capability[] {
    return [...(this.#roles.get(role) ?? [])];
  }

  can(subject: Subject, capability: Capability, resource: Resource): Decision {
    if (!this.#caps.has(capability)) throw new UnknownCapability(capability);

    let decision: Decision = {
      allowed: false,
      reason: "no assignment grants this capability at a covering scope",
      capability,
    };

    for (const a of subject.assignments) {
      if (!covers(a, resource)) continue;
      const granted = a.capability === capability || this.#roles.get(a.role ?? "")?.has(capability);
      if (granted) {
        decision = { allowed: true, reason: `granted by ${a.role ?? a.capability} @ ${a.scope}`, capability, via: a };
        break;
      }
    }

    this.#onDecision?.(decision, subject, resource);
    return decision;
  }

  /** Throwing variant for call sites that should never continue on a deny. */
  assert(subject: Subject, capability: Capability, resource: Resource): void {
    const d = this.can(subject, capability, resource);
    if (!d.allowed) {
      throw new KernelError("FORBIDDEN", `${subject.kind}:${subject.id} may not ${capability}`, {
        capability,
        reason: d.reason,
        resource,
      });
    }
  }
}
