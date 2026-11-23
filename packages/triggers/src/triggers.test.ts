import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { openMemoryDb, createKernel, type Kernel } from "@harness/kernel";
import {
  cronMatches,
  signWebhook,
  TriggerEngine,
  verifyWebhook,
  WebhookRejected,
} from "./triggers.ts";

const SCOPE = { tenantId: "t1", workspaceId: "ws1", projectId: "p1" };

async function setup(now = () => 1_700_000_000_000): Promise<{
  k: Kernel;
  engine: TriggerEngine;
  ran: string[];
  close: () => Promise<void>;
}> {
  const mem = await openMemoryDb();
  const k = await createKernel(mem.db);
  k.registry.define({ type: "pr.opened", schema: z.object({ number: z.number(), draft: z.boolean() }) });
  k.registry.define({ type: "nightly.started", schema: z.object({ at: z.string() }) });
  const ran: string[] = [];
  k.steps.register({
    kind: "ci",
    async run(ctx, input) {
      ran.push(JSON.stringify(input));
      return ctx.step("build", async () => ({ ok: true }));
    },
  });
  const engine = new TriggerEngine({ db: mem.db, log: k.log, steps: k.steps, now });
  return { k, engine, ran, close: mem.close };
}

describe("cron parsing", () => {
  const at = (iso: string) => new Date(iso);

  test("matches wildcards, steps, ranges and lists", () => {
    assert.equal(cronMatches("* * * * *", at("2026-03-04T09:15:00Z")), true);
    assert.equal(cronMatches("0 * * * *", at("2026-03-04T09:00:00Z")), true);
    assert.equal(cronMatches("0 * * * *", at("2026-03-04T09:15:00Z")), false);
    assert.equal(cronMatches("*/15 * * * *", at("2026-03-04T09:30:00Z")), true);
    assert.equal(cronMatches("*/15 * * * *", at("2026-03-04T09:31:00Z")), false);
    assert.equal(cronMatches("37 8 * * 1-5", at("2026-03-04T08:37:00Z")), true, "Wednesday");
    assert.equal(cronMatches("37 8 * * 1-5", at("2026-03-07T08:37:00Z")), false, "Saturday");
    assert.equal(cronMatches("0 9,17 * * *", at("2026-03-04T17:00:00Z")), true);
  });

  test("rejects a malformed expression at registration time", () => {
    assert.throws(() => cronMatches("* * *", new Date()), /5 fields/);
  });
});

describe("webhook verification", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ action: "opened", number: 42 });

  test("a correctly signed payload passes", () => {
    const ts = 1_700_000_000_000;
    const sig = signWebhook(secret, ts, body);
    assert.doesNotThrow(() => verifyWebhook(secret, ts, body, sig, { now: ts }));
  });

  test("a tampered body fails", () => {
    const ts = 1_700_000_000_000;
    const sig = signWebhook(secret, ts, body);
    assert.throws(
      () => verifyWebhook(secret, ts, body + " ", sig, { now: ts }),
      WebhookRejected,
    );
  });

  test("a replayed payload outside the tolerance window fails", () => {
    const ts = 1_700_000_000_000;
    const sig = signWebhook(secret, ts, body);
    assert.throws(
      () => verifyWebhook(secret, ts, body, sig, { now: ts + 10 * 60 * 1000 }),
      /timestamp outside tolerance/,
    );
  });

  test("the wrong secret fails", () => {
    const ts = 1_700_000_000_000;
    assert.throws(
      () => verifyWebhook(secret, ts, body, signWebhook("other", ts, body), { now: ts }),
      /bad signature/,
    );
  });
});

describe("trigger engine", () => {
  test("an event trigger starts a flow and correlates the chain", async () => {
    const { k, engine, ran, close } = await setup();
    engine.register({
      projectId: "p1",
      name: "CI on PR",
      enabled: true,
      concurrency: "allow",
      source: { kind: "event", match: "pr.*" },
      action: { kind: "flow", flowKind: "ci" },
    });

    const ev = await k.log.append({
      ...SCOPE,
      stream: "project:p1",
      type: "pr.opened",
      payload: { number: 42, draft: false },
      actor: { kind: "system", id: "github" },
    });

    const fired = await engine.onEvent(ev);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].state, "fired");
    assert.ok(fired[0].runId);
    assert.ok(fired[0].correlationId);

    await k.steps.execute(fired[0].runId!);
    assert.match(ran[0], /"number":42/);
    await close();
  });

  test("a where-clause filters which events fire the trigger", async () => {
    const { k, engine, close } = await setup();
    engine.register({
      projectId: "p1",
      name: "non-draft only",
      enabled: true,
      concurrency: "allow",
      source: { kind: "event", match: "pr.opened", where: { path: "draft", equals: false } },
      action: { kind: "flow", flowKind: "ci" },
    });

    const draft = await k.log.append({
      ...SCOPE, stream: "s", type: "pr.opened",
      payload: { number: 1, draft: true }, actor: { kind: "system", id: "gh" },
    });
    assert.equal((await engine.onEvent(draft)).length, 0, "draft PRs skipped");

    const ready = await k.log.append({
      ...SCOPE, stream: "s", type: "pr.opened",
      payload: { number: 2, draft: false }, actor: { kind: "system", id: "gh" },
    });
    assert.equal((await engine.onEvent(ready)).length, 1);
    await close();
  });

  test("a disabled trigger records a skip rather than vanishing", async () => {
    const { k, engine, close } = await setup();
    engine.register({
      projectId: "p1", name: "off", enabled: false, concurrency: "allow",
      source: { kind: "event", match: "*" },
      action: { kind: "flow", flowKind: "ci" },
    });
    const ev = await k.log.append({
      ...SCOPE, stream: "s", type: "pr.opened",
      payload: { number: 1, draft: false }, actor: { kind: "system", id: "gh" },
    });
    const [f] = await engine.onEvent(ev);
    assert.equal(f.state, "skipped");
    assert.equal(f.reason, "disabled");
    await close();
  });

  test("concurrency 'skip' refuses to start a second overlapping run", async () => {
    const { k, engine, close } = await setup();
    const t = engine.register({
      projectId: "p1", name: "serial", enabled: true, concurrency: "skip",
      source: { kind: "event", match: "pr.opened" },
      action: { kind: "flow", flowKind: "ci" },
    });
    const mk = () =>
      k.log.append({
        ...SCOPE, stream: "s", type: "pr.opened",
        payload: { number: Math.floor(Math.random() * 1000), draft: false },
        actor: { kind: "system", id: "gh" },
      });

    assert.equal((await engine.onEvent(await mk()))[0].state, "fired");
    assert.equal((await engine.onEvent(await mk()))[0].state, "skipped");

    engine.complete(t.id);
    assert.equal((await engine.onEvent(await mk()))[0].state, "fired", "runs again once free");
    await close();
  });

  test("rate limiting dead-letters the excess instead of hammering the runtime", async () => {
    let now = 1_700_000_000_000;
    const { k, engine, close } = await setup(() => now);
    engine.register({
      projectId: "p1", name: "chatty", enabled: true, concurrency: "allow",
      rateLimit: { perMinute: 2 },
      source: { kind: "event", match: "pr.opened" },
      action: { kind: "flow", flowKind: "ci" },
    });
    const mk = () =>
      k.log.append({
        ...SCOPE, stream: "s", type: "pr.opened",
        payload: { number: 1, draft: false }, actor: { kind: "system", id: "gh" },
      });

    assert.equal((await engine.onEvent(await mk()))[0].state, "fired");
    assert.equal((await engine.onEvent(await mk()))[0].state, "fired");
    assert.equal((await engine.onEvent(await mk()))[0].state, "rate-limited");
    assert.equal(engine.deadLetters().length, 1);

    now += 61_000;
    assert.equal((await engine.onEvent(await mk()))[0].state, "fired", "window rolled over");
    await close();
  });

  test("a cron trigger fires only on a matching minute", async () => {
    const { engine, close } = await setup();
    engine.register({
      projectId: "p1", name: "nightly", enabled: true, concurrency: "skip",
      source: { kind: "cron", expression: "37 2 * * *" },
      action: { kind: "flow", flowKind: "ci" },
    });

    assert.equal((await engine.tick(new Date("2026-03-04T02:36:00Z"), SCOPE)).length, 0);
    const fired = await engine.tick(new Date("2026-03-04T02:37:00Z"), SCOPE);
    assert.equal(fired.length, 1);
    assert.equal(fired[0].state, "fired");
    await close();
  });

  test("a signed inbound webhook fires; an unsigned one never becomes an event", async () => {
    const ts = 1_700_000_000_000;
    const { engine, close } = await setup(() => ts);
    engine.register({
      projectId: "p1", name: "deploy hook", enabled: true, concurrency: "allow",
      source: { kind: "webhook", token: "tok-123", secret: "whsec" },
      action: { kind: "flow", flowKind: "ci" },
    });

    const body = JSON.stringify({ ref: "refs/heads/main" });
    const f = await engine.onWebhook(
      "tok-123", body, { timestamp: ts, signature: signWebhook("whsec", ts, body) }, SCOPE,
    );
    assert.equal(f.state, "fired");

    await assert.rejects(
      () => engine.onWebhook("tok-123", body, { timestamp: ts, signature: "deadbeef" }, SCOPE),
      WebhookRejected,
    );
    await assert.rejects(
      () => engine.onWebhook("nope", body, { timestamp: ts, signature: "x" }, SCOPE),
      /unknown token/,
    );
    await close();
  });

  test("a repo trigger fires only for the repo and event kinds it declares", async () => {
    const { engine, close } = await setup();
    engine.register({
      projectId: "p1", name: "api pushes", enabled: true, concurrency: "allow",
      source: { kind: "repo", repo: "acme/api", on: ["push"] },
      action: { kind: "flow", flowKind: "ci" },
    });

    assert.equal((await engine.onRepoEvent("acme/web", "push", {}, SCOPE)).length, 0);
    assert.equal((await engine.onRepoEvent("acme/api", "tag", {}, SCOPE)).length, 0);
    assert.equal((await engine.onRepoEvent("acme/api", "push", {}, SCOPE)).length, 1);
    await close();
  });

  test("an emit action writes an event instead of starting a flow", async () => {
    const { k, engine, close } = await setup();
    engine.register({
      projectId: "p1", name: "announce", enabled: true, concurrency: "allow",
      source: { kind: "cron", expression: "* * * * *" },
      action: { kind: "emit", type: "nightly.started", payload: { at: "now" } },
    });
    const [f] = await engine.tick(new Date("2026-03-04T00:00:00Z"), SCOPE);
    assert.equal(f.state, "fired");
    assert.equal(f.runId, undefined);

    const evs = await k.log.readStream("project:p1");
    assert.equal(evs[0].type, "nightly.started");
    assert.equal(evs[0].correlationId, f.correlationId);
    await close();
  });

  test("a firing against an unregistered flow is recorded as failed, not thrown", async () => {
    const { engine, close } = await setup();
    engine.register({
      projectId: "p1", name: "broken", enabled: true, concurrency: "allow",
      source: { kind: "cron", expression: "* * * * *" },
      action: { kind: "flow", flowKind: "does-not-exist" },
    });
    const [f] = await engine.tick(new Date("2026-03-04T00:00:00Z"), SCOPE);
    assert.equal(f.state, "failed");
    assert.match(f.reason!, /Unknown flow kind/);
    assert.equal(engine.deadLetters().length, 1);
    await close();
  });
});
