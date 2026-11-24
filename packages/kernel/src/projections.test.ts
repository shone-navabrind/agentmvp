import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { openMemoryDb } from "./db.ts";
import { createKernel } from "./kernel.ts";
import { boardProjection, defineBoardEvents, SCOPE, USER } from "./fixtures.ts";
import { ulid } from "./ulid.ts";

function hash(v: unknown): string {
  return createHash("sha256").update(JSON.stringify(v)).digest("hex");
}

describe("projections", () => {
  test("K1 ACCEPTANCE: replay rebuilds a projection byte-identically", async () => {
    const mem = await openMemoryDb();
    const k = await createKernel(mem.db, { ephemeralSecrets: true });
    defineBoardEvents(k.registry);

    // A realistic board history, including one legacy v1 event that must upcast on replay.
    const emit = (type: string, payload: unknown) =>
      k.log.append({ ...SCOPE, stream: "project:p1", type, payload, actor: USER });

    for (const id of ["T1", "T2", "T3"]) {
      await emit("task.created", { taskId: id, title: `task ${id}`, state: "todo" });
    }
    await emit("task.moved.v2", { taskId: "T1", from: "todo", to: "doing" });
    await emit("task.assigned", { taskId: "T1", assigneeKind: "agent", assigneeId: "sess-7" });
    await emit("task.moved.v2", { taskId: "T1", from: "doing", to: "review" });
    await emit("task.moved.v2", { taskId: "T2", from: "todo", to: "doing" });
    await emit("task.assigned", { taskId: "T2", assigneeKind: "user", assigneeId: "u2" });

    // A pre-migration event sitting in history.
    await k.db.query(
      `with nextord as (
         insert into streams (stream, next_seq) values ('__global__', 2)
         on conflict (stream) do update set next_seq = streams.next_seq + 1
         returning next_seq
       )
       insert into events (id, ordinal, stream, seq, type, tenant_id, workspace_id, project_id,
                           actor, at, payload)
       values ($1,
               (select next_seq - 1 from nextord),
               'project:p1',$2,'task.moved.v1','t1','ws1','p1',$3,now(),$4)`,
      [ulid(), 9, JSON.stringify(USER), JSON.stringify({ taskId: "T3", to: "done" })],
    );
    await k.db.query(`update streams set next_seq = 10 where stream = 'project:p1'`);

    const first = await k.projections.run(boardProjection);
    assert.equal(first.applied, 9);
    const snapA = await k.projections.snapshot(boardProjection);

    // Drop the read model entirely and rebuild from the log alone.
    const rebuild = await k.projections.rebuild(boardProjection);
    const snapB = await k.projections.snapshot(boardProjection);

    assert.equal(rebuild.applied, 9, "every event replayed");
    assert.equal(hash(snapA), hash(snapB), "rebuilt state must hash identically to the original");
    assert.deepEqual(snapA, [
      { task_id: "T1", title: "task T1", state: "review", assignee: "agent:sess-7", moves: 2 },
      { task_id: "T2", title: "task T2", state: "doing", assignee: "user:u2", moves: 1 },
      { task_id: "T3", title: "task T3", state: "done", assignee: null, moves: 1 },
    ]);
    await mem.close();
  });

  test("a version bump triggers an automatic rebuild", async () => {
    const mem = await openMemoryDb();
    const k = await createKernel(mem.db, { ephemeralSecrets: true });
    defineBoardEvents(k.registry);
    await k.log.append({
      ...SCOPE,
      stream: "project:v",
      type: "task.created",
      payload: { taskId: "V1", title: "v", state: "todo" },
      actor: USER,
    });

    await k.projections.run(boardProjection);
    const bumped = { ...boardProjection, version: 2 };
    const res = await k.projections.run(bumped);
    assert.equal(res.rebuilt, true, "changing a read model is a code change, not a migration");
    assert.equal(res.applied, 1);
    await mem.close();
  });

  test("catch-up is incremental: a second run applies only new events", async () => {
    const mem = await openMemoryDb();
    const k = await createKernel(mem.db, { ephemeralSecrets: true });
    defineBoardEvents(k.registry);
    const emit = (payload: unknown) =>
      k.log.append({ ...SCOPE, stream: "project:i", type: "task.created", payload, actor: USER });

    await emit({ taskId: "I1", title: "a", state: "todo" });
    assert.equal((await k.projections.run(boardProjection)).applied, 1);
    assert.equal((await k.projections.run(boardProjection)).applied, 0, "nothing new to do");

    await emit({ taskId: "I2", title: "b", state: "todo" });
    assert.equal((await k.projections.run(boardProjection)).applied, 1, "only the new event");
    await mem.close();
  });

  test("a projection crash mid-batch replays the batch rather than skipping it", async () => {
    const mem = await openMemoryDb();
    const k = await createKernel(mem.db, { ephemeralSecrets: true });
    defineBoardEvents(k.registry);
    for (let i = 0; i < 4; i++) {
      await k.log.append({
        ...SCOPE,
        stream: "project:c",
        type: "task.created",
        payload: { taskId: `C${i}`, title: `c${i}`, state: "todo" },
        actor: USER,
      });
    }

    let applied = 0;
    const flaky = {
      ...boardProjection,
      async apply(tx: Parameters<typeof boardProjection.apply>[0], ev: Parameters<typeof boardProjection.apply>[1]) {
        if (applied++ === 2) throw new Error("worker died");
        return boardProjection.apply(tx, ev);
      },
    };

    await assert.rejects(() => k.projections.run(flaky, { batch: 4 }));
    const partial = await k.projections.snapshot(boardProjection);
    assert.deepEqual(partial, [], "the whole batch rolled back; no partial state is visible");

    const after = await k.projections.run(boardProjection, { batch: 4 });
    assert.equal(after.applied, 4, "the batch replays from the uncommitted checkpoint");
    assert.equal(((await k.projections.snapshot(boardProjection)) as unknown[]).length, 4);
    await mem.close();
  });
});
