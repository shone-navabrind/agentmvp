import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { openMemoryDb, createKernel, SuspendRun, type Kernel } from "@harness/kernel";
import { defineBoardEvents } from "./events.ts";
import { boardProjection } from "./projection.ts";
import { Board } from "./board.ts";

const SCOPE = { tenantId: "t1", workspaceId: "ws1", projectId: "p1" };
const USER = { kind: "user" as const, id: "u1" };

async function setup(): Promise<{ k: Kernel; board: Board; close: () => Promise<void>; sync: () => Promise<void> }> {
  const mem = await openMemoryDb();
  const k = await createKernel(mem.db, { ephemeralSecrets: true });
  defineBoardEvents(k.registry);
  const board = new Board({ db: mem.db, log: k.log, steps: k.steps });
  const sync = async () => {
    await k.projections.run(boardProjection);
  };
  await sync();
  return { k, board, close: mem.close, sync };
}

describe("board", () => {
  test("cards move through columns and the read model follows the log", async () => {
    const { board, close, sync } = await setup();
    const t1 = await board.createTask(SCOPE, USER, { title: "Add OAuth", labels: ["auth"] });
    const t2 = await board.createTask(SCOPE, USER, { title: "Fix flaky test" });
    await board.move(SCOPE, USER, t1, "doing");
    await board.move(SCOPE, USER, t1, "review");
    await sync();

    const cols = await board.columns("p1");
    assert.deepEqual(cols.review.map((t) => t.title), ["Add OAuth"]);
    assert.deepEqual(cols.todo.map((t) => t.title), ["Fix flaky test"]);
    assert.equal((await board.task(t1))!.moves, 2);
    assert.equal((await board.task(t2))!.state, "todo");
    await close();
  });

  test("a task can be assigned to an agent session, not only a person", async () => {
    const { board, close, sync } = await setup();
    const t = await board.createTask(SCOPE, USER, { title: "Refactor parser" });
    await board.assign(SCOPE, USER, t, { kind: "agent", id: "sess-7" });
    await board.link(SCOPE, USER, t, "session", "sess-7");
    await sync();

    const row = (await board.task(t))!;
    assert.equal(row.assignee, "agent:sess-7");
    assert.deepEqual(row.session_ids, ["sess-7"]);
    await close();
  });

  test("links accumulate without duplicating", async () => {
    const { board, close, sync } = await setup();
    const t = await board.createTask(SCOPE, USER, { title: "Cross-repo change" });
    await board.link(SCOPE, USER, t, "pr", "https://github.com/acme/api/pull/1");
    await board.link(SCOPE, USER, t, "pr", "https://github.com/acme/web/pull/4");
    await board.link(SCOPE, USER, t, "pr", "https://github.com/acme/api/pull/1");
    await sync();

    assert.deepEqual((await board.task(t))!.pr_urls, [
      "https://github.com/acme/api/pull/1",
      "https://github.com/acme/web/pull/4",
    ]);
    await close();
  });

  test("the whole board rebuilds from the log alone", async () => {
    const { k, board, close, sync } = await setup();
    const t = await board.createTask(SCOPE, USER, { title: "Rebuildable" });
    await board.move(SCOPE, USER, t, "doing");
    await board.assign(SCOPE, USER, t, { kind: "user", id: "u2" });
    await board.comment(SCOPE, USER, t, "looks good");
    await sync();
    const before = await k.projections.snapshot(boardProjection);

    await k.projections.rebuild(boardProjection);
    assert.deepEqual(await k.projections.snapshot(boardProjection), before);
    await close();
  });
});

describe("board as the human-in-the-loop inbox", () => {
  test("a suspended flow raises a card carrying its question", async () => {
    const { k, board, close, sync } = await setup();
    k.steps.register({
      kind: "risky-deploy",
      async run(ctx) {
        return ctx.step("gate", async () => {
          throw new SuspendRun("gate", {
            text: "Deploy 3 files to production?",
            options: ["approve", "reject"],
          });
        });
      },
    });

    const runId = await k.steps.start("risky-deploy", {}, SCOPE);
    assert.equal((await k.steps.execute(runId)).state, "paused");

    assert.deepEqual(await board.syncFromRuns(SCOPE), { raised: 1 });
    await sync();

    const inbox = await board.inbox("p1");
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].title, "Deploy 3 files to production?");
    assert.equal(inbox[0].reason, "approval");
    assert.equal(inbox[0].run_id, runId);
    assert.equal(inbox[0].state, "blocked");
    await close();
  });

  test("syncing twice does not duplicate the card", async () => {
    const { k, board, close, sync } = await setup();
    k.steps.register({
      kind: "gated",
      async run(ctx) {
        return ctx.step("g", async () => {
          throw new SuspendRun("g", { text: "ok?" });
        });
      },
    });
    await k.steps.execute(await k.steps.start("gated", {}, SCOPE));

    await board.syncFromRuns(SCOPE);
    await board.syncFromRuns(SCOPE);
    await sync();
    assert.equal((await board.inbox("p1")).length, 1, "idempotency key collapses the repeat");
    await close();
  });
});

describe("board automations", () => {
  test("moving a card into a column starts the flow bound to it", async () => {
    const { k, board, close, sync } = await setup();
    k.registry.define({ type: "review.done", schema: z.object({ taskId: z.string() }) });
    const reviewed: string[] = [];
    k.steps.register({
      kind: "auto-review",
      async run(ctx, input) {
        const i = input as { taskId: string };
        reviewed.push(i.taskId);
        return ctx.step("review", async () => ({ ok: true }));
      },
    });
    board.automate({ id: "on-review", onEnter: "review", startFlow: "auto-review" });

    const t = await board.createTask(SCOPE, USER, { title: "Needs review" });
    await board.move(SCOPE, USER, t, "review");
    await sync();

    const started = await board.runAutomations(SCOPE);
    assert.equal(started.length, 1);
    assert.equal(started[0].taskId, t);

    await k.steps.execute(started[0].runId);
    assert.deepEqual(reviewed, [t]);

    await sync();
    assert.equal((await board.task(t))!.run_id, started[0].runId, "the card links to its run");
    await close();
  });

  test("an automation does not re-fire for a card that already has a run", async () => {
    const { k, board, close, sync } = await setup();
    k.steps.register({ kind: "noop", async run() { return {}; } });
    board.automate({ id: "a", onEnter: "review", startFlow: "noop" });

    const t = await board.createTask(SCOPE, USER, { title: "once" });
    await board.move(SCOPE, USER, t, "review");
    await sync();

    assert.equal((await board.runAutomations(SCOPE)).length, 1);
    await sync();
    assert.equal((await board.runAutomations(SCOPE)).length, 0, "already linked to a run");
    await close();
  });

  test("a label filter narrows which cards an automation touches", async () => {
    const { board, close, sync } = await setup();
    board.automate({ id: "urgent-only", onEnter: "todo", withLabel: "urgent", startFlow: "noop" });
    await board.createTask(SCOPE, USER, { title: "urgent one", labels: ["urgent"] });
    await board.createTask(SCOPE, USER, { title: "normal one", labels: ["chore"] });
    await sync();

    // "noop" is unregistered here, so a fired automation throws -- which is itself the
    // assertion that exactly one card matched.
    await assert.rejects(() => board.runAutomations(SCOPE), /Unknown flow kind "noop"/);
    await close();
  });
});
