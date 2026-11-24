import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { start } from "./server.ts";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = 8899;
const BASE = `http://127.0.0.1:${PORT}`;
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "public");

const get = async (p: string) => {
  const r = await fetch(BASE + p);
  assert.equal(r.status, 200, `${p} returned ${r.status}`);
  return r.json();
};

/**
 * End-to-end over every package at once: kernel, flow, board, compute, sandbox,
 * triggers, billing and plugins, against one in-process Postgres. If the packages stop
 * composing, this fails -- the unit suites would not notice.
 */
describe("full stack", () => {
  let server: { close: () => Promise<void> };

  before(async () => {
    server = await start(PORT, webRoot);
  });
  after(() => server.close());

  test("the project was placed on a warm sandbox with honest capability reporting", async () => {
    const p = await get("/api/v1/project");
    assert.equal(p.sandbox.fromWarmPool, true, "warm pool turned create into an assignment");
    assert.equal(p.sandbox.state, "running");
    assert.equal(p.sandbox.isolation, "host", "the local driver does not pretend to be a VM");
    assert.equal(p.capacity.maxSessions, 4, "4 GiB / 2 vCPU admits 4 sessions");
    assert.ok(p.capacity.hostFree.memMiB > 0, "host capacity accounted, not ignored");
    assert.equal(p.repos.length, 2);
  });

  test("sessions share one sandbox with disjoint branches and port blocks", async () => {
    const sessions = await get("/api/v1/sessions");
    assert.equal(sessions.length, 4);

    const branches = sessions.map((s: { branch: string }) => s.branch);
    assert.equal(new Set(branches).size, 4, "one branch per session");

    const ports = sessions.map((s: { portRange: { from: number } }) => s.portRange.from);
    assert.equal(new Set(ports).size, 4, "no two sessions share a port block");

    const scopes = sessions.map((s: { cgroupScope: string }) => s.cgroupScope);
    assert.equal(new Set(scopes).size, 4, "one cgroup per session");
  });

  test("chat history is replayed from the event log, in order", async () => {
    const s = await get("/api/v1/sessions/s-auth");
    const types = s.events.map((e: { type: string }) => e.type);
    assert.equal(types[0], "session.started");
    assert.ok(types.includes("tool.ran"));
    const seqs = s.events.map((e: { seq: string }) => Number(e.seq));
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "gapless and ordered");
  });

  test("paused flow runs become board cards in the approval inbox", async () => {
    const board = await get("/api/v1/board");
    assert.ok(board.inbox.length >= 1);
    assert.equal(board.inbox[0].reason, "approval");
    assert.equal(board.inbox[0].state, "blocked");
    assert.ok(board.inbox[0].run_id, "the card links back to the run that raised it");

    const review = board.columns.review ?? [];
    assert.equal(review[0].title, "Add OAuth login");
    assert.equal(review[0].assignee, "agent:s-auth", "a card can be assigned to an agent");
    assert.deepEqual(review[0].pr_urls, ["https://github.com/acme/api/pull/412"]);
  });

  test("a suspended step reads as suspended, never as failed", async () => {
    const flows = await get("/api/v1/flows");
    const paused = flows.runs.filter((r: { state: string }) => r.state === "paused");
    assert.ok(paused.length >= 1);

    for (const run of paused) {
      const states = run.steps.map((s: { state: string }) => s.state);
      assert.ok(
        !states.includes("failed"),
        "waiting on a person must not be recorded as a failure",
      );
      assert.ok(states.includes("suspended"));
    }

    const done = flows.runs.find((r: { kind: string }) => r.kind === "nightly-tests");
    assert.equal(done.state, "completed");
    assert.deepEqual(
      done.steps.map((s: { step_key: string }) => s.step_key),
      ["checkout", "install", "test"],
    );
  });

  test("a PR event fired the CI trigger", async () => {
    const triggers = await get("/api/v1/triggers");
    const ci = triggers.find((t: { id: string }) => t.id === "trg-ci");
    assert.equal(ci.firings, 1);
    assert.equal(ci.lastState, "fired");

    const off = triggers.find((t: { id: string }) => t.id === "trg-deploy");
    assert.equal(off.enabled, false);
    assert.equal(off.firings, 0, "a disabled trigger does nothing");
  });

  test("the ledger reconciles exactly and BYOK spend is not charged", async () => {
    const b = await get("/api/v1/billing");
    assert.equal(b.reconcile.drift, 0, "wallet equals the sum of its billable entries");

    const spent = 250 * 1e6 - Number(b.balanceMicros);
    assert.equal(spent, Math.round((18.42 + 23.17) * 1e6), "BYOK $31.50 excluded");

    const byok = b.entries.find((e: { idem_key: string }) => e.idem_key === "byok-1");
    assert.equal(byok.billable, false);
    assert.equal(b.gatewayBudgets["sk-proj-p1"], 100, "cap is the key ceiling, under balance");
  });

  test("a failing plugin is circuit-broken without affecting the others", async () => {
    const plugins = await get("/api/v1/plugins");
    const flaky = plugins.find((p: { id: string }) => p.id === "acme.flaky");
    assert.equal(flaky.state, "disabled");
    assert.equal(flaky.failures, 3);
    assert.match(flaky.lastError, /upstream 503/);

    const jira = plugins.find((p: { id: string }) => p.id === "acme.jira");
    assert.equal(jira.state, "active", "a neighbour plugin is unaffected");

    const scraper = plugins.find((p: { id: string }) => p.id === "acme.scraper");
    assert.equal(scraper.trust, "untrusted");
    assert.equal(scraper.runtime, "container", "untrusted never runs in-process");
  });

  test("the authz matrix is enforced, not decorative", async () => {
    const rows = await get("/api/v1/authz");
    const member = rows.find((r: { subject: string }) => r.subject === "member");
    assert.equal(member.decisions["project:chat"], true);
    assert.equal(member.decisions["project:terminal:open"], false);

    const granted = rows.find((r: { subject: string }) => r.subject === "member + terminal grant");
    assert.equal(granted.decisions["project:terminal:open"], true);

    const agent = rows.find((r: { subject: string }) => r.subject === "agent session");
    assert.equal(agent.decisions["project:files:write"], true);
    assert.equal(agent.decisions["project:terminal:open"], false, "an agent gets no terminal");
  });

  test("a value declared secret never reaches a client", async () => {
    const bp = await get("/api/v1/blueprints");
    // The real password is in demo-data; neither the bindings nor the rendered
    // compose may carry it, and the compose embeds env values inline.
    assert.equal(bp.bindings.inputs.DB_PASSWORD, "", "secret bindings are blanked");
    assert.ok(!bp.compose.includes("dev-only"), "secret is not baked into the compose");
    assert.match(bp.compose, /PASSWORD: "\u2022+"/, "it is redacted, not simply absent");
    assert.equal(bp.bindings.inputs.ODOO_DB_NAME, "acme", "non-secrets still render");
  });

  test("the blueprint endpoint exposes the catalog and the provisioning plan", async () => {
    const bp = await get("/api/v1/blueprints");
    assert.ok(bp.catalog.length >= 3);
    assert.equal(bp.active.id, "odoo-18-enterprise");
    assert.equal(bp.ready, true);
    const ids = bp.steps.map((s: { id: string }) => s.id);
    assert.ok(ids.includes("acquire") && ids.includes("verify"));
    for (const s of bp.steps) {
      assert.ok(s.label, `step ${s.id} has no plain-language label`);
      assert.ok(!/docker|container|compose/i.test(s.label), `jargon in "${s.label}"`);
    }
  });

  test("the web app is served and references its assets", async () => {
    const html = await (await fetch(BASE + "/")).text();
    assert.match(html, /<title>Harness Cloud<\/title>/);
    assert.match(html, /app\.css/);
    assert.equal((await fetch(BASE + "/app.js")).status, 200);
    assert.equal((await fetch(BASE + "/app.css")).status, 200);
  });
});
