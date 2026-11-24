import { KernelError } from "@harness/kernel";
import { blueprint, type Blueprint } from "./schema.ts";

export class BlueprintInvalid extends KernelError {
  constructor(problems: string[]) {
    super(
      "BLUEPRINT_INVALID",
      `Blueprint failed validation:\n  - ${problems.join("\n  - ")}`,
      { problems },
      false,
    );
  }
}

const REF = /\$\{(input|seed|repo)\.([A-Za-z][A-Za-z0-9_-]*)\}/g;

/** Every ${input.X} / ${seed.X} / ${repo.X} reference found in a value tree. */
function refsIn(value: unknown): Array<{ kind: string; name: string }> {
  const out: Array<{ kind: string; name: string }> = [];
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(REF)) out.push({ kind: m[1], name: m[2] });
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(value);
  return out;
}

function cycles(nodes: string[], edges: Array<[string, string]>): string[] {
  const adj = new Map<string, string[]>();
  for (const [from, to] of edges) adj.set(from, [...(adj.get(from) ?? []), to]);
  const state = new Map<string, 0 | 1 | 2>();
  const found: string[] = [];
  const visit = (id: string, path: string[]): void => {
    const s = state.get(id) ?? 0;
    if (s === 1) {
      found.push([...path.slice(path.indexOf(id)), id].join(" -> "));
      return;
    }
    if (s === 2) return;
    state.set(id, 1);
    for (const n of adj.get(id) ?? []) visit(n, [...path, id]);
    state.set(id, 2);
  };
  nodes.forEach((n) => visit(n, []));
  return found;
}

/**
 * Semantic validation beyond the shape check.
 *
 * This matters most for synthesised blueprints: a model will happily emit a compose
 * file referencing a service that does not exist, a seed pointed at a web server, or a
 * dependency cycle. None of that should reach a VM.
 */
export function validateBlueprint(input: unknown): { ok: true; blueprint: Blueprint } | { ok: false; problems: string[] } {
  const parsed = blueprint.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      problems: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    };
  }
  const bp = parsed.data;
  const problems: string[] = [];

  const serviceNames = new Set(bp.services.map((s) => s.name));
  if (bp.services.length !== serviceNames.size) problems.push("duplicate service names");

  const seedIds = new Set<string>();
  for (const s of bp.seeds) {
    if (seedIds.has(s.id)) problems.push(`duplicate seed id "${s.id}"`);
    seedIds.add(s.id);
    if (!serviceNames.has(s.service)) {
      problems.push(`seed "${s.id}" targets unknown service "${s.service}"`);
      continue;
    }
    const svc = bp.services.find((x) => x.name === s.service)!;
    // Restoring a Postgres dump into an nginx container is a silent disaster at 3am.
    if (svc.dataKind === "none") {
      problems.push(
        `seed "${s.id}" targets service "${s.service}", which declares dataKind "none"`,
      );
    } else if (s.kind !== "files" && svc.dataKind !== s.kind) {
      problems.push(
        `seed "${s.id}" is ${s.kind} but service "${s.service}" holds ${svc.dataKind} data`,
      );
    }
  }

  const repoIds = new Set<string>();
  for (const r of bp.repos) {
    if (repoIds.has(r.id)) problems.push(`duplicate repo slot "${r.id}"`);
    repoIds.add(r.id);
  }
  const mounts = bp.repos.map((r) => r.mountPath);
  if (new Set(mounts).size !== mounts.length) problems.push("two repo slots share a mountPath");

  const inputKeys = new Set(bp.inputs.map((i) => i.key));
  if (bp.inputs.length !== inputKeys.size) problems.push("duplicate input keys");

  // Unresolvable references are the most common synthesis failure.
  const known = { input: inputKeys, seed: seedIds, repo: repoIds };
  for (const { kind, name } of refsIn({
    services: bp.services,
    setup: bp.setup,
    verify: bp.verify,
  })) {
    const set = known[kind as keyof typeof known];
    if (set && !set.has(name)) problems.push(`reference \${${kind}.${name}} has no matching ${kind}`);
  }

  for (const s of bp.services) {
    for (const dep of s.dependsOn) {
      if (!serviceNames.has(dep)) problems.push(`service "${s.name}" depends on unknown "${dep}"`);
    }
  }
  const cyc = cycles(
    bp.services.map((s) => s.name),
    bp.services.flatMap((s) => s.dependsOn.map((d) => [s.name, d] as [string, string])),
  );
  for (const c of cyc) problems.push(`service dependency cycle: ${c}`);

  const fixedHostPorts = bp.services
    .flatMap((s) => s.ports.filter((p) => p.host !== undefined).map((p) => p.host!))
    .sort();
  for (let i = 1; i < fixedHostPorts.length; i++) {
    if (fixedHostPorts[i] === fixedHostPorts[i - 1]) {
      problems.push(`two services both bind host port ${fixedHostPorts[i]}`);
    }
  }
  const primaries = bp.services.flatMap((s) => s.ports.filter((p) => p.primary));
  if (primaries.length > 1) problems.push("more than one port marked primary");
  if (bp.services.length > 0 && primaries.length === 0) {
    problems.push("no port marked primary, so the preview has nothing to open");
  }

  for (const step of bp.setup) {
    if (step.run === "service" && !step.service) {
      problems.push(`setup step "${step.id}" runs in a service but names none`);
    }
    if (step.run === "service" && step.service && !serviceNames.has(step.service)) {
      problems.push(`setup step "${step.id}" names unknown service "${step.service}"`);
    }
  }
  const stepIds = bp.setup.map((s) => s.id);
  if (new Set(stepIds).size !== stepIds.length) problems.push("duplicate setup step ids");

  if (bp.services.length > 0 && !bp.sandbox.needsDocker) {
    problems.push("blueprint declares services but sandbox.needsDocker is false");
  }
  if (bp.verify.length === 0) {
    problems.push("no verify checks: provisioning could report ready without proof");
  }

  // The non-technical wizard renders ui.whatYouGet verbatim; empty means a blank screen.
  if (bp.ui.whatYouGet.length === 0) problems.push("ui.whatYouGet is empty");

  return problems.length ? { ok: false, problems } : { ok: true, blueprint: bp };
}

export function assertBlueprint(input: unknown): Blueprint {
  const r = validateBlueprint(input);
  if (!r.ok) throw new BlueprintInvalid(r.problems);
  return r.blueprint;
}

/** Inputs/seeds/repos a project must supply before this blueprint can be provisioned. */
export function requirementsOf(bp: Blueprint): {
  inputs: string[];
  seeds: string[];
  repos: string[];
} {
  return {
    inputs: bp.inputs.filter((i) => i.required).map((i) => i.key),
    seeds: bp.seeds.filter((s) => s.required).map((s) => s.id),
    repos: bp.repos.filter((r) => r.required).map((r) => r.id),
  };
}
