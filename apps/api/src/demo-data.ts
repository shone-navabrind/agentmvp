import { z } from "zod";
import { createKernel, openMemoryDb, SuspendRun, type Kernel } from "@harness/kernel";
import { Board, boardProjection, defineBoardEvents } from "@harness/board";
import { HostPool, LocalProcessDriver, Scheduler } from "@harness/compute";
import { maxSessionsFor, SessionManager } from "@harness/sandbox";
import { Ledger, BudgetEnforcer, type GatewayAdmin, type GatewayKey } from "@harness/billing";
import { TriggerEngine } from "@harness/triggers";
import { compileGraph, standardNodes, defineNode, type Graph } from "@harness/flow";
import { PluginHost, parseManifest } from "@harness/plugins";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type Demo = Awaited<ReturnType<typeof buildDemo>>;

const SCOPE = { tenantId: "t1", workspaceId: "ws1", projectId: "p1" };
const USER = { kind: "user" as const, id: "u-shone" };

/**
 * Boots every package together against one in-process Postgres and drives it through a
 * realistic scenario. This is the API's data source for the UI, and doubles as the
 * integration test: if the packages do not compose, this throws.
 */
export async function buildDemo() {
  const mem = await openMemoryDb();
  const k: Kernel = await createKernel(mem.db);

  // ---- events -------------------------------------------------------------
  defineBoardEvents(k.registry);
  k.registry.define({ type: "session.started", schema: z.object({ sessionId: z.string(), branch: z.string() }) });
  k.registry.define({ type: "session.text", schema: z.object({ sessionId: z.string(), text: z.string() }) });
  k.registry.define({ type: "tool.ran", schema: z.object({ sessionId: z.string(), name: z.string(), summary: z.string() }) });
  k.registry.define({ type: "provision.progress", schema: z.object({ step: z.string() }) });
  k.registry.define({ type: "pr.opened", schema: z.object({ number: z.number(), repo: z.string() }) });

  // ---- authz --------------------------------------------------------------
  const CAPS = [
    "project:read", "project:chat", "project:terminal:open", "project:files:write",
    "workspace:members:manage", "workspace:budget:manage", "plugin:install",
  ];
  k.authz
    .defineCapability(...CAPS)
    .defineRole("member", ["project:read", "project:chat"])
    .defineRole("admin", CAPS.filter((c) => c !== "plugin:install"))
    .defineRole("superadmin", CAPS);

  // ---- compute ------------------------------------------------------------
  const pool = new HostPool().addHost({
    id: "node-1",
    total: { vcpu: 16, memMiB: 32768, diskGiB: 500 },
    reserved: { vcpu: 2, memMiB: 4096, diskGiB: 50 },
    overcommit: { vcpu: 2, memMiB: 1, diskGiB: 1 },
  });
  const root = await mkdtemp(join(tmpdir(), "hc-demo-"));
  const driver = new LocalProcessDriver({ root, pool, hostId: "node-1" });
  const scheduler = new Scheduler({ drivers: [driver], targetWarm: 2 });
  await scheduler.refillWarmPool({
    imageVersion: "1.4.0",
    size: { vcpu: 2, memMiB: 4096, diskGiB: 20 },
    enrollmentToken: "warm",
  });
  const acquired = await scheduler.acquire({
    projectId: "p1",
    imageVersion: "1.4.0",
    size: { vcpu: 2, memMiB: 4096, diskGiB: 20 },
    enrollmentToken: "tok-p1",
  });

  // ---- sessions -----------------------------------------------------------
  const sessions = new SessionManager({ size: { vcpu: 2, memMiB: 4096 }, basePort: 40000 });
  const sessionNames: Record<string, string> = {
    "s-auth": "Add OAuth login",
    "s-perf": "Profile the slow query",
    "s-docs": "Rewrite the README",
    "s-queue": "Migrate to pg-boss",
  };
  for (const id of Object.keys(sessionNames)) {
    const rec = sessions.admit(id, "p1");
    if (rec.state === "starting") sessions.transition(id, "active");
    await k.log.append({
      ...SCOPE, stream: `session:${id}`, type: "session.started",
      payload: { sessionId: id, branch: rec.branch }, actor: USER,
    });
  }
  sessions.transition("s-docs", "idle");

  // ---- a conversation -----------------------------------------------------
  const chat: Array<[string, string]> = [
    ["session.text", "Add Google OAuth to the login page, keep the existing password flow."],
    ["tool.ran", "Read 4 files"],
    ["tool.ran", "Edited src/auth/oauth.ts, src/routes/login.tsx"],
    ["session.text", "Added the provider and wired the callback route. Running the tests."],
    ["tool.ran", "Ran 38 tests - all passing"],
    ["session.text", "Done. The login page now offers Google alongside email and password."],
  ];
  for (const [type, text] of chat) {
    await k.log.append({
      ...SCOPE, stream: "session:s-auth", type,
      payload: type === "tool.ran"
        ? { sessionId: "s-auth", name: text.split(" ")[0].toLowerCase(), summary: text }
        : { sessionId: "s-auth", text },
      actor: type === "session.text" && text.startsWith("Add Google") ? USER : { kind: "agent", id: "s-auth" },
    });
  }

  // ---- board --------------------------------------------------------------
  const board = new Board({ db: mem.db, log: k.log, steps: k.steps });
  const sync = () => k.projections.run(boardProjection);
  await sync();

  const t1 = await board.createTask(SCOPE, USER, { title: "Add OAuth login", labels: ["auth"] });
  const t2 = await board.createTask(SCOPE, USER, { title: "Profile the slow query", labels: ["perf"] });
  const t3 = await board.createTask(SCOPE, USER, { title: "Rewrite the README", labels: ["docs"] });
  const t4 = await board.createTask(SCOPE, USER, { title: "Migrate to pg-boss", labels: ["infra"] });
  const t5 = await board.createTask(SCOPE, USER, { title: "Upgrade Node to 22 LTS" });

  await board.move(SCOPE, USER, t1, "review");
  await board.assign(SCOPE, USER, t1, { kind: "agent", id: "s-auth" });
  await board.link(SCOPE, USER, t1, "session", "s-auth");
  await board.link(SCOPE, USER, t1, "pr", "https://github.com/acme/api/pull/412");

  await board.move(SCOPE, USER, t2, "doing");
  await board.assign(SCOPE, USER, t2, { kind: "agent", id: "s-perf" });
  await board.link(SCOPE, USER, t2, "session", "s-perf");

  await board.move(SCOPE, USER, t3, "doing");
  await board.assign(SCOPE, USER, t3, { kind: "user", id: "u-shone" });
  await board.move(SCOPE, USER, t4, "done");
  await board.comment(SCOPE, USER, t5, "blocked on the image rebuild");

  // ---- flows --------------------------------------------------------------
  const reg = standardNodes().register(
    defineNode({
      type: "deploy.release",
      configSchema: z.object({ env: z.string() }),
      inputSchema: z.object({ decision: z.string() }),
      outputSchema: z.object({ released: z.boolean() }),
      async execute(_c, cfg, input) {
        return { released: input.decision === "approve" && cfg.env === "production" };
      },
    }),
  );

  const releaseGraph: Graph = {
    name: "release",
    entry: "plan",
    guards: { maxSteps: 20, maxCostUsd: 5 },
    nodes: [
      { id: "plan", type: "core.const", config: { value: "2 repos, 7 files, 38 tests green" } },
      {
        id: "gate",
        type: "core.approval",
        config: { options: ["approve", "reject"] },
        input: { question: "Release acme/api #412 to production?", context: "$.nodes.plan.value" },
      },
      { id: "ship", type: "deploy.release", config: { env: "production" }, input: { decision: "$.nodes.gate.decision" } },
    ],
    edges: [
      { from: "plan", to: "gate" },
      { from: "gate", to: "ship" },
    ],
    output: { released: "$.nodes.ship.released" },
  };
  k.steps.register(compileGraph(releaseGraph, reg));

  k.steps.register({
    kind: "nightly-tests",
    async run(ctx) {
      await ctx.step("checkout", async () => ({ sha: "a91f3c2" }));
      await ctx.step("install", async () => ({ packages: 412 }));
      return ctx.step("test", async () => ({ passed: 38, failed: 0 }));
    },
  });

  const releaseRun = await k.steps.start("graph:release", {}, SCOPE);
  await k.steps.execute(releaseRun); // -> paused on the approval gate

  const nightlyRun = await k.steps.start("nightly-tests", {}, SCOPE);
  await k.steps.execute(nightlyRun);

  const failingRun = await k.steps.start("graph:release", {}, SCOPE);
  await k.steps.execute(failingRun);

  await board.syncFromRuns(SCOPE);
  await sync();

  // ---- triggers -----------------------------------------------------------
  const triggers = new TriggerEngine({ db: mem.db, log: k.log, steps: k.steps });
  triggers.register({
    id: "trg-ci", projectId: "p1", name: "Tests on every PR", enabled: true,
    concurrency: "cancel-previous",
    source: { kind: "event", match: "pr.*" },
    action: { kind: "flow", flowKind: "nightly-tests" },
  });
  triggers.register({
    id: "trg-nightly", projectId: "p1", name: "Nightly suite", enabled: true,
    concurrency: "skip",
    source: { kind: "cron", expression: "37 2 * * *" },
    action: { kind: "flow", flowKind: "nightly-tests" },
  });
  triggers.register({
    id: "trg-deploy", projectId: "p1", name: "Deploy webhook", enabled: false,
    concurrency: "queue",
    source: { kind: "webhook", token: "tok-deploy", secret: "whsec" },
    action: { kind: "flow", flowKind: "graph:release" },
  });
  const prEvent = await k.log.append({
    ...SCOPE, stream: "project:p1", type: "pr.opened",
    payload: { number: 412, repo: "acme/api" }, actor: { kind: "system", id: "github" },
  });
  await triggers.onEvent(prEvent);

  // ---- billing ------------------------------------------------------------
  const ledger = new Ledger(mem.db);
  await ledger.migrate();
  await ledger.grant("ws1", 250, "seed-grant");
  const gatewayKeys: GatewayKey[] = [
    { projectId: "p1", workspaceId: "ws1", litellmKeyId: "sk-proj-p1", maxBudgetUsd: 100, models: ["claude-sonnet-5-5", "gpt-5"] },
  ];
  const budgets: Record<string, number> = {};
  const gateway: GatewayAdmin = {
    async setKeyBudget(id, usd) { budgets[id] = usd; },
    async revokeKey() {},
    async pullSpend() {
      return [
        { keyId: "sk-proj-p1", usd: 18.42, windowId: "w1" },
        { keyId: "sk-proj-p1", usd: 23.17, windowId: "w2" },
      ];
    },
  };
  const enforcer = new BudgetEnforcer({ ledger, gateway });
  await enforcer.syncSpend(gatewayKeys);
  await ledger.debit({ workspaceId: "ws1", projectId: "p1", usd: 31.5, idemKey: "byok-1", billable: false });
  await enforcer.pushBudgets("ws1", gatewayKeys);
  const alerts = await enforcer.checkAlerts("ws1", 250);

  // ---- plugins ------------------------------------------------------------
  const plugins = new PluginHost({
    apiVersion: "1.2.0",
    async emit() {},
    async secret() { return "redacted"; },
  });
  await plugins.load({
    manifest: parseManifest({
      id: "acme.jira", version: "1.4.0", apiVersion: "^1.0",
      runtime: "in-process", trust: "verified",
      provides: [{ point: "connector.egress", name: "jira" }],
      capabilities: ["http:egress:api.atlassian.com", "secret:read:workspace/jira-token"],
      description: "Mirror board tasks to Jira issues",
    }),
    activate: () => ({ jira: { send: async () => "ok" } }),
  });
  await plugins.load({
    manifest: parseManifest({
      id: "acme.scraper", version: "0.3.1", apiVersion: "^1.0",
      runtime: "container", trust: "untrusted",
      provides: [{ point: "flow.node", name: "scrape" }],
      capabilities: ["http:egress:*"],
      description: "Fetch a page and extract text (sandboxed)",
    }),
    activate: () => ({ scrape: {} }),
  });
  const broken = {
    manifest: parseManifest({
      id: "acme.flaky", version: "1.0.0", apiVersion: "^1.0",
      runtime: "in-process", trust: "verified",
      provides: [{ point: "connector.egress", name: "flaky" }],
      capabilities: [],
      description: "Deliberately failing, to show the circuit breaker",
    }),
    activate: () => ({ flaky: { send: async () => { throw new Error("upstream 503"); } } }),
  };
  await plugins.load(broken);
  for (let i = 0; i < 3; i++) {
    await plugins
      .call("acme.flaky", "flaky", (impl) => (impl as { send: () => Promise<void> }).send())
      .catch(() => undefined);
  }

  await sync();

  return {
    kernel: k,
    db: mem.db,
    board,
    sessions,
    sessionNames,
    scheduler,
    pool,
    driver,
    sandboxRef: acquired,
    triggers,
    ledger,
    enforcer,
    gatewayKeys,
    budgets,
    alerts,
    plugins,
    runs: { releaseRun, nightlyRun, failingRun },
    scope: SCOPE,
    maxSessions: maxSessionsFor({ vcpu: 2, memMiB: 4096 }),
    close: async () => {
      await mem.close();
    },
  };
}
