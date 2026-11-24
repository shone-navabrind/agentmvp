import { z } from "zod";
import { spawn as spawnChild } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  createKernel, openFileDb, openPostgresDb, KernelError, LocalMasterKey, ulid, type Kernel, type Event,
} from "@harness/kernel";
import { Board, boardProjection, defineBoardEvents, TASK_STATES } from "@harness/board";
import { SessionManager, WorktreeManager } from "@harness/sandbox";
import { Ledger } from "@harness/billing";
import { ClaudeCodeAdapter, type ProcessHandle, type Spawn } from "@harness/harness";
import { CATALOG, findBlueprint, renderCompose, primaryPort, friendlyStepLabels } from "@harness/blueprints";

/**
 * The real, persisted mode. It boots with nothing in it: no projects, no sessions, no
 * spend. Everything the UI shows was created through the API and lives in the event log
 * (PGlite on disk), so it survives a restart. The scripted scenario lives in
 * demo-data.ts and only runs when HARNESS_DEMO=1.
 */

// Single-tenant until auth (K0) lands; every row is still scoped as the kernel requires.
const TENANT = "t1";
const WS = "ws1";
const DIR_STREAM = `workspace:${WS}`;
const USER = { kind: "user" as const, id: "local" };
const SIZE = { vcpu: 2, memMiB: 4096 };

export type Project = {
  id: string;
  name: string;
  repoUrl: string | null;
  repoName: string | null;
  repoStatus: "none" | "cloning" | "ready" | "failed";
  repoError: string | null;
  blueprintId: string | null;
  createdAt: string;
};

type SessionMeta = { id: string; projectId: string; title: string; cwd: string; createdAt: string };
type Live = { adapter: ClaudeCodeAdapter; harnessId: string; busy: boolean };

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const createProject = z.object({
  name: z.string().trim().min(1).max(80),
  // https only: no ssh keys live here, and a value starting with "-" can never reach git.
  repoUrl: z.string().trim().url().startsWith("https://").max(500).optional().or(z.literal("").transform(() => undefined)),
});
const createSession = z.object({ project: z.string().min(1), title: z.string().trim().min(1).max(120) });
const postMessage = z.object({ text: z.string().trim().min(1).max(20_000) });
const createTask = z.object({ project: z.string().min(1), title: z.string().trim().min(1).max(200) });
const moveTask = z.object({ to: z.enum(TASK_STATES) });
const chooseBlueprint = z.object({ blueprintId: z.string().nullable() });

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; "));
  return r.data;
}

/** child_process behind the adapter's Spawn interface. */
export function nodeSpawn(baseEnv: Record<string, string>): Spawn {
  return (argv, opts) => {
    const child = spawnChild(argv[0], argv.slice(1), {
      cwd: opts.cwd,
      // Blank values (e.g. ANTHROPIC_API_KEY= from compose) are dropped so they cannot
      // shadow a credential that is actually set.
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...baseEnv, ...opts.env }).filter(
          // The platform's own database must never be reachable from an agent's shell.
          ([k, v]) => v !== undefined && v !== "" && k !== "DATABASE_URL" && !/^(PG|POSTGRES_)/.test(k),
        ),
      ),
      // stderr goes straight to the server log, so a full pipe can never stall the agent.
      stdio: ["pipe", "pipe", "inherit"],
    });
    const exited = new Promise<number>((resolve) => {
      child.on("error", () => {
        child.stdout?.destroy();
        resolve(127);
      });
      child.on("close", (code) => resolve(code ?? 1));
    });
    child.stdin?.on("error", () => {}); // EPIPE after exit is reported via wait(), not a crash
    const handle: ProcessHandle = {
      write: (line) => void child.stdin?.write(line),
      wait: () => exited,
      kill: () => void child.kill(),
      stdout: createInterface({ input: child.stdout! }),
      stderr: (async function* () {})(),
    };
    return handle;
  };
}

async function masterKey(dataDir: string): Promise<LocalMasterKey> {
  const path = join(dataDir, "master.key");
  try {
    return new LocalMasterKey(await readFile(path));
  } catch {
    const key = randomBytes(32);
    await writeFile(path, key, { mode: 0o600 });
    return new LocalMasterKey(key);
  }
}

export async function buildApp(opts: { dataDir: string; databaseUrl?: string; spawn?: Spawn }) {
  const { dataDir } = opts;
  await mkdir(dataDir, { recursive: true });
  const agentHome = join(dataDir, "agent-home");
  await mkdir(agentHome, { recursive: true });

  // Postgres when DATABASE_URL is set (the compose default); embedded PGlite on disk otherwise.
  const store = opts.databaseUrl ? await openPostgresDb(opts.databaseUrl) : await openFileDb(join(dataDir, "pg"));
  const k: Kernel = await createKernel(store.db, { keyWrapper: await masterKey(dataDir) });

  // ---- events ----
  defineBoardEvents(k.registry);
  k.registry.define({ type: "project.created", schema: z.object({ projectId: z.string(), name: z.string(), repoUrl: z.string().nullable(), repoName: z.string().nullable() }) });
  k.registry.define({ type: "project.repo", schema: z.object({ projectId: z.string(), status: z.enum(["cloning", "ready", "failed"]), error: z.string().nullable() }) });
  k.registry.define({ type: "project.blueprint", schema: z.object({ projectId: z.string(), blueprintId: z.string().nullable() }) });
  k.registry.define({ type: "session.created", schema: z.object({ sessionId: z.string(), projectId: z.string(), title: z.string(), cwd: z.string() }) });
  k.registry.define({ type: "session.started", schema: z.object({ sessionId: z.string(), branch: z.string() }) });
  k.registry.define({ type: "session.text", schema: z.object({ sessionId: z.string(), text: z.string() }) });
  k.registry.define({ type: "tool.ran", schema: z.object({ sessionId: z.string(), name: z.string(), summary: z.string() }) });
  k.registry.define({ type: "session.error", schema: z.object({ sessionId: z.string(), message: z.string() }) });

  // ---- authz: same roles as the demo, plus the write capabilities ----
  const CAPS = [
    "project:read", "project:write", "project:chat", "project:terminal:open", "project:files:write",
    "workspace:projects:create", "workspace:members:manage", "workspace:budget:manage", "plugin:install",
  ];
  k.authz
    .defineCapability(...CAPS)
    .defineRole("member", ["project:read", "project:write", "project:chat"])
    .defineRole("admin", CAPS.filter((c) => c !== "plugin:install"))
    .defineRole("superadmin", CAPS);

  const board = new Board({ db: store.db, log: k.log, steps: k.steps });
  const syncBoard = () => k.projections.run(boardProjection);
  const ledger = new Ledger(store.db);
  await ledger.migrate();

  // ---- agent availability: the CLI must exist and something must authenticate it ----
  const gatewayBaseUrl = process.env.HARNESS_GATEWAY_URL ?? "";
  const gatewayKey = process.env.HARNESS_GATEWAY_KEY ?? "";
  const model = process.env.HARNESS_MODEL || "claude-sonnet-5-5";
  const spawn = opts.spawn ?? nodeSpawn({ HOME: agentHome });
  const agent = { available: false, reason: "", version: "" };
  try {
    const probe = new ClaudeCodeAdapter({ spawn, fs: { mkdirp: async () => {}, writeFile: async () => {} } });
    agent.version = (await probe.check()).version;
    const hasKey = Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN || (gatewayBaseUrl && gatewayKey));
    agent.available = hasKey;
    if (!hasKey) agent.reason = "No model credentials. Set ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN) and restart.";
  } catch {
    agent.reason = "The Claude Code CLI is not installed where the server runs.";
  }

  // ---- rebuild in-memory state from the log ----
  const projects = new Map<string, Project>();
  const sessionMeta = new Map<string, SessionMeta>();
  const managers = new Map<string, SessionManager>();
  const live = new Map<string, Live>();

  const managerFor = (projectId: string) => {
    let m = managers.get(projectId);
    if (!m) managers.set(projectId, (m = new SessionManager({ size: SIZE, basePort: 40000 })));
    return m;
  };
  const projectDir = (id: string) => join(dataDir, "projects", id);
  const worktreesFor = (id: string) =>
    new WorktreeManager({ gitRoot: join(projectDir(id), "git"), workRoot: join(projectDir(id), "work") });

  function fold(e: Event): void {
    const p = e.payload as Record<string, string | null>;
    if (e.type === "project.created") {
      projects.set(p.projectId!, {
        id: p.projectId!, name: p.name!, repoUrl: p.repoUrl, repoName: p.repoName,
        repoStatus: p.repoUrl ? "cloning" : "none", repoError: null, blueprintId: null, createdAt: e.at,
      });
    } else if (e.type === "project.repo") {
      const proj = projects.get(p.projectId!);
      if (proj) Object.assign(proj, { repoStatus: p.status, repoError: p.error });
    } else if (e.type === "project.blueprint") {
      const proj = projects.get(p.projectId!);
      if (proj) proj.blueprintId = p.blueprintId;
    } else if (e.type === "session.created") {
      sessionMeta.set(p.sessionId!, { id: p.sessionId!, projectId: p.projectId!, title: p.title!, cwd: p.cwd!, createdAt: e.at });
      const rec = managerFor(p.projectId!).admit(p.sessionId!, p.projectId!);
      if (rec.state === "starting") managerFor(p.projectId!).transition(rec.id, "active");
    }
  }
  // shortcut: one read of the directory stream, capped at 100k events; page it when a workspace outgrows that.
  for (const e of await k.log.readStream(DIR_STREAM, { limit: 100_000 })) fold(e);

  const append = async (stream: string, projectId: string, type: string, payload: unknown, actor: { kind: "user" | "agent" | "system"; id: string } = USER) => {
    const e = await k.log.append({ tenantId: TENANT, workspaceId: WS, projectId, stream, type, payload, actor });
    if (stream === DIR_STREAM) fold(e);
    return e;
  };

  async function cloneRepo(p: Project): Promise<void> {
    const wt = worktreesFor(p.id);
    try {
      await rm(wt.barePath(p.repoName!), { recursive: true, force: true });
      await wt.addRepo({ name: p.repoName!, remoteUrl: p.repoUrl!, defaultBranch: "HEAD" });
      await append(DIR_STREAM, p.id, "project.repo", { projectId: p.id, status: "ready", error: null });
    } catch (err) {
      const msg = err instanceof KernelError ? err.message : String(err);
      await append(DIR_STREAM, p.id, "project.repo", { projectId: p.id, status: "failed", error: msg.slice(0, 500) });
    }
  }
  // A clone interrupted by a restart is started again rather than left "cloning" forever.
  for (const p of projects.values()) if (p.repoStatus === "cloning") void cloneRepo(p);

  const must = (id: string | null) => {
    const p = id ? projects.get(id) : undefined;
    if (!p) throw new HttpError(404, `No project "${id}"`);
    return p;
  };
  const mustSession = (id: string) => {
    const s = sessionMeta.get(id);
    if (!s) throw new HttpError(404, `No session "${id}"`);
    return s;
  };
  const scopeOf = (projectId: string) => ({ tenantId: TENANT, workspaceId: WS, projectId });

  // ---- the agent loop: harness events become log events ----
  async function pump(sessionId: string, l: Live): Promise<void> {
    const s = mustSession(sessionId);
    const stream = `session:${sessionId}`;
    const asAgent = { kind: "agent" as const, id: sessionId };
    try {
      for await (const e of l.adapter.events(l.harnessId)) {
        if (e.type === "text.delta" && e.text.trim()) {
          await append(stream, s.projectId, "session.text", { sessionId, text: e.text }, asAgent);
        } else if (e.type === "tool.start") {
          await append(stream, s.projectId, "tool.ran", { sessionId, name: e.name, summary: e.summary }, asAgent);
        } else if (e.type === "error") {
          await append(stream, s.projectId, "session.error", { sessionId, message: e.message }, asAgent);
        } else if (e.type === "usage") {
          l.busy = false;
          // Your own key: recorded so spend is visible, never charged against credits.
          if (e.costUsd) {
            await ledger.debit({ workspaceId: WS, projectId: s.projectId, usd: e.costUsd, idemKey: `usage-${ulid()}`, billable: false });
          }
        }
      }
    } catch (err) {
      await append(stream, s.projectId, "session.error", { sessionId, message: String(err) }, asAgent).catch(() => {});
    } finally {
      // The process ended; the next message starts a fresh one in the same working copy.
      if (l.busy) {
        await append(stream, s.projectId, "session.error", { sessionId, message: "The agent process exited before finishing. The server log has its stderr." }, asAgent).catch(() => {});
      }
      if (live.get(sessionId) === l) live.delete(sessionId);
    }
  }

  async function startAgent(s: SessionMeta): Promise<Live> {
    const p = must(s.projectId);
    const bp = p.blueprintId ? findBlueprint(p.blueprintId) : undefined;
    const adapter = new ClaudeCodeAdapter({
      spawn,
      home: agentHome,
      fs: {
        mkdirp: (path) => mkdir(path, { recursive: true }).then(() => {}),
        // Never overwrite a CLAUDE.md the user's repo already has.
        writeFile: (path, content) =>
          writeFile(path, content, { flag: basename(path) === "CLAUDE.md" ? "wx" : "w" }).catch((err) => {
            if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
          }),
      },
    });
    await adapter.configure({
      gatewayBaseUrl, projectKey: gatewayKey, defaultModel: model, workdir: s.cwd,
      models: [{ id: model, label: model, api: "anthropic-messages" }],
      instructions: bp?.bundles.instructions ?? "",
    });
    const l: Live = { adapter, harnessId: await adapter.createSession({ cwd: s.cwd, model }), busy: false };
    live.set(s.id, l);
    void pump(s.id, l);
    return l;
  }

  // ---- read side ----
  const sessionsOf = (projectId: string) =>
    managerFor(projectId).list().map((r) => ({
      ...r,
      title: sessionMeta.get(r.id)?.title ?? r.id,
      busy: live.get(r.id)?.busy ?? false,
    }));

  async function get(path: string, q: URLSearchParams): Promise<unknown> {
    if (path === "/api/v1/workspace") {
      return {
        demo: false,
        onboarded: projects.size > 0,
        workspace: "Local workspace",
        projects: [...projects.values()],
        agent: { ...agent, model },
      };
    }
    // Every other route is about one project.
    const p = must(q.get("project"));

    if (path === "/api/v1/project") {
      const m = managerFor(p.id);
      return {
        id: p.id, name: p.name, workspace: "Local workspace",
        harness: "claude-code", model, imageVersion: null,
        sandbox: {
          id: p.id, driver: "local-process", host: "this container",
          // Agents run in the server's own container, not a VM: say so.
          isolation: "none", fromWarmPool: false, state: "running", size: SIZE,
        },
        repos: p.repoUrl ? [{ name: p.repoName, remote: p.repoUrl, branch: "HEAD", status: p.repoStatus, error: p.repoError }] : [],
        capacity: { maxSessions: m.maxSessions, activeSessions: m.activeCount(), warmPool: 0 },
        runs: [],
      };
    }
    if (path === "/api/v1/sessions") return sessionsOf(p.id);
    if (path === "/api/v1/board") {
      await syncBoard();
      return { columns: await board.columns(p.id), inbox: await board.inbox(p.id) };
    }
    if (path === "/api/v1/flows") return { runs: [], awaiting: [] };
    if (path === "/api/v1/triggers") return [];
    if (path === "/api/v1/plugins") return [];
    if (path === "/api/v1/events") {
      const r = await k.db.query<{ seq: string; type: string }>(
        `select seq::text as seq, type from events where project_id = $1 order by ordinal desc limit 25`,
        [p.id],
      );
      return r.rows;
    }
    if (path === "/api/v1/billing") {
      const entries = await ledger.entries(WS);
      const granted = entries.filter((e) => e.kind === "grant").reduce((a, e) => a + Number(e.amount_micros), 0) / 1e6;
      return {
        balanceMicros: await ledger.balance(WS), granted,
        entries: entries.slice(-8), byProject: await ledger.spendByProject(WS),
        reconcile: await ledger.reconcile(WS), gatewayBudgets: {}, alerts: [],
      };
    }
    if (path === "/api/v1/blueprints") {
      const bp = p.blueprintId ? findBlueprint(p.blueprintId) : undefined;
      const empty = { inputs: {}, seeds: {}, repos: {} };
      return {
        catalog: CATALOG.map((x) => ({
          id: x.id, name: x.name, summary: x.summary, tags: x.tags, origin: x.origin,
          services: x.services.length, estimateMinutes: x.ui.estimateMinutes, whatYouGet: x.ui.whatYouGet,
          needs: {
            repos: x.repos.map((r) => ({ id: r.id, label: r.label, required: r.required, hint: r.hint })),
            seeds: x.seeds.map((s) => ({ id: s.id, label: s.label, required: s.required, hint: s.hint, scrubs: s.neutralize.recipes })),
            inputs: x.inputs.map((i) => ({ key: i.key, label: i.label, required: i.required, secret: i.secret, hint: i.hint })),
          },
        })),
        active: bp ? { id: bp.id, name: bp.name, summary: bp.summary, whatYouGet: bp.ui.whatYouGet, estimateMinutes: bp.ui.estimateMinutes } : null,
        bindings: empty,
        inputsSet: {},
        // Provisioning nodes are not implemented (D10), so nothing is ever "ready" to run.
        ready: false,
        provisioningBuilt: false,
        previewPort: bp ? primaryPort(bp, 40000) : null,
        compose: bp ? renderCompose(bp, empty, { portBase: 40000 }) : "",
        steps: bp ? Object.entries(friendlyStepLabels(bp)).map(([id, label]) => ({ id, type: "", label })) : [],
      };
    }
    if (path === "/api/v1/scope") return scopeOf(p.id);
    return undefined;
  }

  async function getSession(id: string): Promise<unknown> {
    const s = mustSession(id);
    const events = await k.log.readStream(`session:${id}`, { limit: 5000 });
    return { id, title: s.title, projectId: s.projectId, cwd: s.cwd, busy: live.get(id)?.busy ?? false, events };
  }

  // ---- write side ----
  async function post(path: string, body: unknown): Promise<unknown> {
    if (path === "/api/v1/projects") {
      const input = parse(createProject, body);
      const id = `p-${ulid().slice(-10).toLowerCase()}`;
      const repoName = input.repoUrl
        ? basename(new URL(input.repoUrl).pathname).replace(/\.git$/, "").replace(/[^A-Za-z0-9._-]/g, "-") || "repo"
        : null;
      await mkdir(projectDir(id), { recursive: true });
      await append(DIR_STREAM, id, "project.created", { projectId: id, name: input.name, repoUrl: input.repoUrl ?? null, repoName });
      const p = must(id);
      if (p.repoUrl) void cloneRepo(p);
      return p;
    }

    let m = path.match(/^\/api\/v1\/projects\/([^/]+)\/blueprint$/);
    if (m) {
      const p = must(m[1]);
      const { blueprintId } = parse(chooseBlueprint, body);
      if (blueprintId && !findBlueprint(blueprintId)) throw new HttpError(400, `Unknown blueprint "${blueprintId}"`);
      await append(DIR_STREAM, p.id, "project.blueprint", { projectId: p.id, blueprintId });
      return must(p.id);
    }

    if (path === "/api/v1/sessions") {
      const input = parse(createSession, body);
      const p = must(input.project);
      if (p.repoStatus === "cloning") throw new HttpError(409, "The repository is still cloning. Try again in a moment.");
      const id = `s-${ulid().slice(-8).toLowerCase()}`;
      const branch = `session/${id}`;
      let cwd: string;
      if (p.repoStatus === "ready") {
        try {
          cwd = (await worktreesFor(p.id).createWorktree(id, p.repoName!)).path;
        } catch (err) {
          throw new HttpError(409, `Could not create a working copy: ${err instanceof Error ? err.message : err}`);
        }
      } else {
        cwd = join(projectDir(p.id), "work", id);
        await mkdir(cwd, { recursive: true });
      }
      await append(DIR_STREAM, p.id, "session.created", { sessionId: id, projectId: p.id, title: input.title, cwd });
      await append(`session:${id}`, p.id, "session.started", { sessionId: id, branch: p.repoStatus === "ready" ? branch : "no repository" });
      return sessionsOf(p.id).find((s) => s.id === id);
    }

    m = path.match(/^\/api\/v1\/sessions\/([^/]+)\/messages$/);
    if (m) {
      const s = mustSession(m[1]);
      const { text } = parse(postMessage, body);
      if (!agent.available) throw new HttpError(409, agent.reason);
      let l = live.get(s.id);
      if (l?.busy) throw new HttpError(409, "The agent is still working on the previous message.");
      await append(`session:${s.id}`, s.projectId, "session.text", { sessionId: s.id, text });
      l ??= await startAgent(s);
      l.busy = true;
      await l.adapter.prompt(l.harnessId, { text });
      return { ok: true };
    }

    if (path === "/api/v1/board/tasks") {
      const input = parse(createTask, body);
      const p = must(input.project);
      const taskId = await board.createTask(scopeOf(p.id), USER, { title: input.title });
      await syncBoard();
      return { taskId };
    }

    m = path.match(/^\/api\/v1\/board\/tasks\/([^/]+)\/move$/);
    if (m) {
      const task = await board.task(m[1]);
      if (!task) throw new HttpError(404, `No task "${m[1]}"`);
      const { to } = parse(moveTask, body);
      await board.move(scopeOf(task.project_id), USER, task.task_id, to);
      await syncBoard();
      return { ok: true };
    }
    return undefined;
  }

  return {
    kernel: k,
    get,
    getSession,
    post,
    close: async () => {
      for (const l of live.values()) await l.adapter.close(l.harnessId).catch(() => {});
      await store.close();
    },
  };
}

export type App = Awaited<ReturnType<typeof buildApp>>;
