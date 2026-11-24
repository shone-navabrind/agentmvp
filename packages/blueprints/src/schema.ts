import { z } from "zod";

/**
 * A Blueprint is the declarative definition of a working environment: what the sandbox
 * needs, which services run in it, where attached repos mount, what data the user
 * uploads, and which agent capabilities are preloaded.
 *
 * The central design decision: a curated catalog entry and an AI-synthesised stack
 * produce the SAME artifact and run through the SAME provisioning pipeline. There is no
 * second code path for "custom" stacks -- synthesis just emits a Blueprint, which is
 * validated here before anything touches a VM.
 */

export const portMapping = z.object({
  container: z.number().int().min(1).max(65535),
  /** Omit to let the session's port block decide; set only when a service needs a fixed port. */
  host: z.number().int().min(1).max(65535).optional(),
  /** Marks the port the preview should open by default. */
  primary: z.boolean().default(false),
  label: z.string().optional(),
});

export const healthcheck = z.object({
  /** Shell command run inside the service container; exit 0 means healthy. */
  test: z.string().min(1),
  intervalSec: z.number().int().positive().default(5),
  timeoutSec: z.number().int().positive().default(3),
  retries: z.number().int().positive().default(30),
});

export const service = z.object({
  name: z.string().regex(/^[a-z][a-z0-9-]*$/, "service names are lowercase kebab"),
  image: z.string().min(1),
  command: z.string().optional(),
  /** Values may reference inputs as ${input.KEY} and seeds as ${seed.ID}. */
  env: z.record(z.string()).default({}),
  ports: z.array(portMapping).default([]),
  /** host:container, relative to /workspace unless absolute. */
  volumes: z.array(z.string()).default([]),
  dependsOn: z.array(z.string()).default([]),
  healthcheck: healthcheck.optional(),
  /** Databases get restored into; marks which seed kind this service accepts. */
  dataKind: z.enum(["postgres", "mysql", "mongo", "files", "none"]).default("none"),
});

export const repoSlot = z.object({
  /** Stable key the UI and setup steps refer to, e.g. "addons" or "theme". */
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  label: z.string().min(1),
  /** Where the worktree is mounted inside the sandbox. */
  mountPath: z.string().startsWith("/"),
  required: z.boolean().default(true),
  multiple: z.boolean().default(false),
  hint: z.string().optional(),
});

export const seedSlot = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  label: z.string().min(1),
  kind: z.enum(["postgres", "mysql", "mongo", "files"]),
  /** Which service receives the restore. */
  service: z.string().min(1),
  accepts: z.array(z.string()).default([".sql", ".dump", ".tar.gz", ".zip"]),
  required: z.boolean().default(false),
  maxMiB: z.number().int().positive().default(2048),
  /**
   * Production dumps routinely carry real customer data. A blueprint declares whether
   * the platform should scrub it before the agent is ever pointed at the database.
   */
  neutralize: z
    .object({
      enabled: z.boolean().default(true),
      /** Named recipes the restore step applies after loading. */
      recipes: z.array(z.string()).default([]),
    })
    .default({ enabled: true, recipes: [] }),
  hint: z.string().optional(),
});

export const inputSlot = z.object({
  key: z.string().regex(/^[A-Z][A-Z0-9_]*$/, "inputs are SCREAMING_SNAKE"),
  label: z.string().min(1),
  required: z.boolean().default(true),
  secret: z.boolean().default(false),
  default: z.string().optional(),
  /** Plain-language help shown in the non-technical wizard. */
  hint: z.string().optional(),
  pattern: z.string().optional(),
});

export const setupStep = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  label: z.string().min(1),
  /** Run on the sandbox host, or inside a named service container. */
  run: z.enum(["host", "service"]).default("host"),
  service: z.string().optional(),
  script: z.string().min(1),
  /** Steps must be safe to re-run: provisioning resumes after a crash. */
  idempotent: z.boolean().default(true),
  timeoutSec: z.number().int().positive().default(900),
});

export const verifyCheck = z.object({
  id: z.string().regex(/^[a-z][a-z0-9_-]*$/),
  label: z.string().min(1),
  kind: z.enum(["http", "shell", "port"]),
  /** http: a URL; shell: a command; port: a port number. */
  target: z.string().min(1),
  expect: z.string().optional(),
  timeoutSec: z.number().int().positive().default(120),
});

export const bundles = z.object({
  /** Skill package ids preloaded into the sandbox for the agent. */
  skills: z.array(z.string()).default([]),
  mcp: z
    .array(
      z.object({
        name: z.string(),
        command: z.string(),
        args: z.array(z.string()).default([]),
        env: z.record(z.string()).default({}),
      }),
    )
    .default([]),
  /** Merged into AGENTS.md / CLAUDE.md so the agent knows the stack it is standing in. */
  instructions: z.string().default(""),
});

export const blueprint = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string().min(1),
  summary: z.string().min(1).max(200),
  /** How this blueprint came to exist. Synthesised ones are reviewable before first use. */
  origin: z.enum(["catalog", "synthesized", "saved"]).default("catalog"),
  tags: z.array(z.string()).default([]),

  sandbox: z
    .object({
      vcpu: z.number().int().min(1).max(32).default(2),
      memMiB: z.number().int().min(1024).default(4096),
      diskGiB: z.number().int().min(5).default(20),
      needsDocker: z.boolean().default(true),
      minIsolation: z.enum(["container", "microvm", "vm"]).default("vm"),
    })
    .default({}),

  services: z.array(service).default([]),
  repos: z.array(repoSlot).default([]),
  seeds: z.array(seedSlot).default([]),
  inputs: z.array(inputSlot).default([]),
  setup: z.array(setupStep).default([]),
  verify: z.array(verifyCheck).default([]),
  bundles: bundles.default({ skills: [], mcp: [], instructions: "" }),

  /** Copy for the non-technical wizard. No jargon allowed here. */
  ui: z
    .object({
      whatYouGet: z.array(z.string()).default([]),
      estimateMinutes: z.number().int().positive().default(5),
      /** Shown while provisioning, in plain language, one per setup step. */
      friendlySteps: z.record(z.string()).default({}),
    })
    .default({}),
});

export type Blueprint = z.infer<typeof blueprint>;
export type Service = z.infer<typeof service>;
export type RepoSlot = z.infer<typeof repoSlot>;
export type SeedSlot = z.infer<typeof seedSlot>;
export type InputSlot = z.infer<typeof inputSlot>;
export type SetupStep = z.infer<typeof setupStep>;
export type VerifyCheck = z.infer<typeof verifyCheck>;
