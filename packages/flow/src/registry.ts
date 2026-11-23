import type { Graph, NodeType } from "./types.ts";
import { GraphInvalid } from "./types.ts";
import { nodeRefs } from "./refs.ts";
import { pathExists, requiredKeys } from "./schema-introspect.ts";

export class NodeRegistry {
  #types = new Map<string, NodeType<never, never, never>>();

  register<C, I, O>(t: NodeType<C, I, O>): this {
    if (this.#types.has(t.type)) throw new Error(`Node type "${t.type}" already registered`);
    this.#types.set(t.type, t as unknown as NodeType<never, never, never>);
    return this;
  }

  get(type: string): NodeType<never, never, never> | undefined {
    return this.#types.get(type);
  }

  list(): string[] {
    return [...this.#types.keys()].sort();
  }

  /**
   * Validate a graph at SAVE time, not run time. This is the whole point of typed edges:
   * a flow with a mistyped reference or a missing required input is rejected in the editor,
   * before anyone runs it against a metered gateway.
   */
  validate(g: Graph): { ok: true } | { ok: false; problems: string[] } {
    const problems: string[] = [];
    const byId = new Map<string, (typeof g.nodes)[number]>();

    for (const n of g.nodes) {
      if (byId.has(n.id)) problems.push(`duplicate node id "${n.id}"`);
      byId.set(n.id, n);
    }
    if (g.nodes.length === 0) problems.push("graph has no nodes");
    if (!byId.has(g.entry)) problems.push(`entry node "${g.entry}" does not exist`);

    for (const n of g.nodes) {
      const t = this.#types.get(n.type);
      if (!t) {
        problems.push(`node "${n.id}" uses unregistered type "${n.type}"`);
        continue;
      }
      const cfg = t.configSchema.safeParse(n.config ?? {});
      if (!cfg.success) {
        problems.push(`node "${n.id}" config invalid: ${cfg.error.issues.map((i) => i.message).join("; ")}`);
      }
      const provided = new Set(Object.keys(n.input ?? {}));
      for (const key of requiredKeys(t.inputSchema)) {
        if (!provided.has(key)) {
          problems.push(`node "${n.id}" (${n.type}) is missing required input "${key}"`);
        }
      }
      // Every $.nodes.<id>.<path> must name a real node and a field that node can produce.
      for (const ref of nodeRefs(n.input)) {
        const src = byId.get(ref.nodeId);
        if (!src) {
          problems.push(`node "${n.id}" references unknown node "${ref.nodeId}"`);
          continue;
        }
        if (ref.nodeId === n.id) {
          problems.push(`node "${n.id}" references its own output`);
          continue;
        }
        const srcType = this.#types.get(src.type);
        if (!srcType) continue;
        if (pathExists(srcType.outputSchema, ref.path) === false) {
          problems.push(
            `node "${n.id}" references "$.nodes.${ref.nodeId}.${ref.path.join(".")}", ` +
              `which "${src.type}" does not produce`,
          );
        }
      }
    }

    for (const e of g.edges) {
      if (!byId.has(e.from)) problems.push(`edge from unknown node "${e.from}"`);
      if (!byId.has(e.to)) problems.push(`edge to unknown node "${e.to}"`);
    }

    // Reachability
    const adj = new Map<string, string[]>();
    for (const e of g.edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    const seen = new Set<string>();
    const stack = [g.entry];
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id) || !byId.has(id)) continue;
      seen.add(id);
      stack.push(...(adj.get(id) ?? []));
    }
    for (const n of g.nodes) {
      if (!seen.has(n.id)) problems.push(`node "${n.id}" is unreachable from entry`);
    }

    // Cycles must be guarded, or an agent loop runs until the wallet is empty.
    if (hasCycle(g.nodes.map((n) => n.id), g.edges)) {
      const guarded =
        g.guards?.maxSteps !== undefined ||
        g.guards?.maxCostUsd !== undefined ||
        g.guards?.maxWallClockMs !== undefined ||
        g.nodes.some((n) => n.maxIterations !== undefined);
      if (!guarded) {
        problems.push(
          "graph contains a cycle but declares no guard " +
            "(guards.maxSteps / maxCostUsd / maxWallClockMs, or a node maxIterations)",
        );
      }
    }

    for (const ref of nodeRefs(g.output)) {
      if (!byId.has(ref.nodeId)) problems.push(`output references unknown node "${ref.nodeId}"`);
    }

    return problems.length ? { ok: false, problems } : { ok: true };
  }

  assertValid(g: Graph): void {
    const r = this.validate(g);
    if (!r.ok) throw new GraphInvalid(r.problems);
  }
}

function hasCycle(ids: string[], edges: Array<{ from: string; to: string }>): boolean {
  const adj = new Map<string, string[]>();
  for (const e of edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): boolean => {
    const s = state.get(id) ?? 0;
    if (s === 1) return true;
    if (s === 2) return false;
    state.set(id, 1);
    for (const next of adj.get(id) ?? []) if (visit(next)) return true;
    state.set(id, 2);
    return false;
  };
  return ids.some((id) => visit(id));
}
