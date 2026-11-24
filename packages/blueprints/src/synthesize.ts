import { KernelError } from "@harness/kernel";
import type { Blueprint } from "./schema.ts";
import { validateBlueprint } from "./validate.ts";
import { CATALOG } from "./catalog.ts";

/**
 * "I need Django 5 with Postgres and Redis" -> a validated Blueprint.
 *
 * Synthesis does not get its own provisioning path. It emits the same artifact the
 * catalog holds, is checked by the same validator, and runs through the same compiler.
 * A stack nobody anticipated is therefore exactly as debuggable as a curated one.
 */

export type StackRequest = {
  /** What the user typed, in their own words. */
  text: string;
  /** Optional signals from an attached repo that make the guess far better. */
  detected?: {
    languages?: string[];
    packageFiles?: string[];
    frameworks?: string[];
    hasDockerfile?: boolean;
    hasCompose?: boolean;
  };
};

/** Returns raw JSON text; the caller validates. Kept narrow so tests can fake it. */
export interface BlueprintModel {
  complete(prompt: string, opts: { maxTokens: number }): Promise<string>;
}

export class SynthesisFailed extends KernelError {
  constructor(attempts: number, problems: string[]) {
    super(
      "BLUEPRINT_SYNTHESIS_FAILED",
      `Could not produce a valid environment after ${attempts} attempts`,
      { attempts, problems },
      false,
    );
  }
}

const RULES = `
You design reproducible development environments as a single JSON "Blueprint".

Hard rules:
- Output ONLY JSON. No prose, no markdown fence.
- Every service runs from a published image on a public registry. Pin a major version.
- Exactly one port across all services has "primary": true. That is what the preview opens.
- Any service that holds data sets "dataKind" to postgres|mysql|mongo|files. Others set "none".
- A seed's "kind" must match the "dataKind" of the service it targets.
- Every \${input.X} you reference must exist in "inputs"; same for \${seed.X} and \${repo.X}.
- Databases get a healthcheck, and services that need them list them in "dependsOn".
- "verify" must be non-empty: at least one check proving the stack actually serves.
- "setup" scripts must be safe to run twice. Guard installs with a test.
- Secrets are declared as inputs with "secret": true, never hardcoded.
- "ui.whatYouGet" is 2-4 plain sentences for a non-technical reader. No jargon, no
  product names they would not know, no mention of Docker, ports or containers.
- Never include a command that deletes data outside /workspace.
`.trim();

function shape(): string {
  // One real catalog entry teaches the shape far better than a schema dump.
  const example = CATALOG.find((b) => b.id === "node-22-postgres")!;
  return JSON.stringify(example, null, 1);
}

export function buildPrompt(req: StackRequest, priorProblems: string[] = []): string {
  const detected = req.detected
    ? `\nSignals detected in the attached repository:\n${JSON.stringify(req.detected, null, 1)}`
    : "";
  const repair = priorProblems.length
    ? `\nYour previous attempt was rejected. Fix exactly these problems and change nothing else:\n- ${priorProblems.join("\n- ")}`
    : "";
  return [
    RULES,
    `\nHere is a valid Blueprint, as a shape reference:\n${shape()}`,
    `\nThe user asked for:\n${req.text}`,
    detected,
    repair,
    `\nReturn the Blueprint JSON for that request.`,
  ].join("\n");
}

function extractJson(raw: string): unknown {
  const trimmed = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start === -1 || end === -1) throw new Error("no JSON object in model output");
  return JSON.parse(trimmed.slice(start, end + 1));
}

export type SynthesisResult = {
  blueprint: Blueprint;
  attempts: number;
  /** Problems seen and repaired on the way, for the audit trail. */
  repaired: string[][];
};

/**
 * Synthesise with a bounded repair loop. Validation failures are fed back verbatim,
 * which fixes most of them in one round; after maxAttempts it gives up loudly rather
 * than shipping something half-valid.
 */
export async function synthesizeBlueprint(
  model: BlueprintModel,
  req: StackRequest,
  opts: { maxAttempts?: number } = {},
): Promise<SynthesisResult> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const repaired: string[][] = [];
  let problems: string[] = [];

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let candidate: unknown;
    try {
      candidate = extractJson(await model.complete(buildPrompt(req, problems), { maxTokens: 8000 }));
    } catch (err) {
      problems = [`output was not valid JSON: ${String(err)}`];
      repaired.push(problems);
      continue;
    }

    // Synthesised blueprints are marked as such and reviewed before their first run:
    // an environment definition is executable, so this is a privilege boundary.
    const withOrigin = { ...(candidate as object), origin: "synthesized" };
    const result = validateBlueprint(withOrigin);
    if (result.ok) return { blueprint: result.blueprint, attempts: attempt, repaired };

    problems = result.problems;
    repaired.push(problems);
  }
  throw new SynthesisFailed(maxAttempts, problems);
}

/**
 * Promote a synthesised blueprint to a saved one an org can reuse. This is the
 * "turn what we just built into a template" path, and it is deliberately explicit:
 * a human marks it reusable, which is also when it stops needing per-run review.
 */
export function saveAsTemplate(bp: Blueprint, opts: { id: string; name: string; approvedBy: string }): Blueprint {
  return {
    ...bp,
    id: opts.id,
    name: opts.name,
    origin: "saved",
    tags: [...new Set([...bp.tags, "saved"])],
  };
}

/** Does this blueprint need a human to look at it before it is allowed to run? */
export function needsReview(bp: Blueprint): boolean {
  return bp.origin === "synthesized";
}
