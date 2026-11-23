import type { Condition, Ref } from "./types.ts";

export type RunState = {
  input: unknown;
  nodes: Record<string, unknown>;
  state: Record<string, unknown>;
  iteration: Record<string, number>;
};

const REF = /^\$\.(input|nodes|state|iteration)(?:\.(.*))?$/;

export function parseRef(r: unknown): { root: string; path: string[] } | null {
  if (typeof r !== "string") return null;
  const m = REF.exec(r);
  if (!m) return null;
  return { root: m[1], path: m[2] ? m[2].split(".") : [] };
}

function dig(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const key of path) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** Resolve a ref tree against run state. Literals pass through; no eval, ever. */
export function resolve(ref: Ref, st: RunState): unknown {
  const parsed = parseRef(ref);
  if (parsed) {
    const root =
      parsed.root === "input"
        ? st.input
        : parsed.root === "nodes"
          ? st.nodes
          : parsed.root === "state"
            ? st.state
            : st.iteration;
    return dig(root, parsed.path);
  }
  if (Array.isArray(ref)) return ref.map((r) => resolve(r, st));
  if (ref && typeof ref === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ref)) out[k] = resolve(v as Ref, st);
    return out;
  }
  return ref;
}

export function resolveInput(
  mapping: Record<string, Ref> | undefined,
  st: RunState,
): Record<string, unknown> {
  if (!mapping) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(mapping)) out[k] = resolve(v, st);
  return out;
}

export function evaluate(c: Condition, st: RunState): boolean {
  switch (c.op) {
    case "always":
      return true;
    case "eq":
      return Object.is(resolve(c.left, st), resolve(c.right, st));
    case "neq":
      return !Object.is(resolve(c.left, st), resolve(c.right, st));
    case "gt":
      return Number(resolve(c.left, st)) > Number(resolve(c.right, st));
    case "lt":
      return Number(resolve(c.left, st)) < Number(resolve(c.right, st));
    case "truthy":
      return Boolean(resolve(c.value, st));
    case "not":
      return !evaluate(c.of, st);
    case "and":
      return c.all.every((x) => evaluate(x, st));
    case "or":
      return c.any.some((x) => evaluate(x, st));
  }
}

/** Every `$.nodes.<id>...` reference inside a ref tree or condition. */
export function nodeRefs(x: unknown): Array<{ nodeId: string; path: string[] }> {
  const out: Array<{ nodeId: string; path: string[] }> = [];
  const walk = (v: unknown): void => {
    const p = parseRef(v);
    if (p) {
      if (p.root === "nodes" && p.path.length > 0) {
        out.push({ nodeId: p.path[0], path: p.path.slice(1) });
      }
      return;
    }
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(x);
  return out;
}
