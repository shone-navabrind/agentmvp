import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { openMemoryDb } from "./db.ts";
import { createKernel, type Kernel } from "./kernel.ts";
import { defineBoardEvents, SCOPE, USER } from "./fixtures.ts";
import { InvalidEventPayload, SupersededEventType, UnknownEventType } from "./types.ts";
import { ulid } from "./ulid.ts";

describe("event log", () => {
  let k: Kernel;
  let close: () => Promise<void>;

  before(async () => {
    const mem = await openMemoryDb();
    close = mem.close;
    k = await createKernel(mem.db);
    defineBoardEvents(k.registry);
  });
  after(() => close());

  test("rejects an unregistered event type", async () => {
    await assert.rejects(
      () => k.log.append({ ...SCOPE, stream: "s:1", type: "nope.happened", payload: {}, actor: USER }),
      UnknownEventType,
    );
  });

  test("rejects a payload that fails its schema", async () => {
    await assert.rejects(
      () =>
        k.log.append({
          ...SCOPE,
          stream: "s:1",
          type: "task.created",
          payload: { taskId: "T1", title: 42, state: "todo" },
          actor: USER,
        }),
      InvalidEventPayload,
    );
  });

  test("refuses to write a superseded event type", async () => {
    await assert.rejects(
      () =>
        k.log.append({
          ...SCOPE,
          stream: "s:1",
          type: "task.moved.v1",
          payload: { taskId: "T1", to: "doing" },
          actor: USER,
        }),
      SupersededEventType,
    );
  });

  test("assigns a gapless 1-based sequence per stream", async () => {
    for (let i = 0; i < 5; i++) {
      await k.log.append({
        ...SCOPE,
        stream: "project:gap",
        type: "task.created",
        payload: { taskId: `T${i}`, title: `t${i}`, state: "todo" },
        actor: USER,
      });
    }
    const evs = await k.log.readStream("project:gap");
    assert.deepEqual(
      evs.map((e) => e.seq),
      ["1", "2", "3", "4", "5"],
    );
  });

  test("stays gapless when 50 appends race on one stream", async () => {
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        k.log.append({
          ...SCOPE,
          stream: "project:race",
          type: "task.created",
          payload: { taskId: `R${i}`, title: `r${i}`, state: "todo" },
          actor: USER,
        }),
      ),
    );
    const evs = await k.log.readStream("project:race", { limit: 100 });
    assert.equal(evs.length, 50);
    assert.deepEqual(
      evs.map((e) => Number(e.seq)),
      Array.from({ length: 50 }, (_, i) => i + 1),
      "sequence must be gapless and contiguous under concurrency",
    );
  });

  test("idempotency key collapses a retried append", async () => {
    const input = {
      ...SCOPE,
      stream: "project:idem",
      type: "task.created" as const,
      payload: { taskId: "T9", title: "once", state: "todo" },
      actor: USER,
      idemKey: "create-T9",
    };
    const a = await k.log.append(input);
    const b = await k.log.append(input);
    assert.equal(a.id, b.id, "same event returned, not a second one");
    assert.equal((await k.log.readStream("project:idem")).length, 1);
  });

  test("ULIDs are monotonic within a millisecond", () => {
    const now = Date.now();
    const ids = Array.from({ length: 1000 }, () => ulid(now));
    const sorted = [...ids].sort();
    assert.deepEqual(ids, sorted, "ids minted in the same ms must still sort in creation order");
    assert.equal(new Set(ids).size, 1000);
  });

  test("upcasts a superseded payload on read", async () => {
    // Simulate history: a v1 event written before the schema changed.
    await k.db.query(
      `insert into events (id, stream, seq, type, tenant_id, workspace_id, project_id,
                           actor, at, payload)
       values ($1,'project:old',1,'task.moved.v1','t1','ws1','p1',$2,now(),$3)`,
      [ulid(), JSON.stringify(USER), JSON.stringify({ taskId: "T1", to: "done" })],
    );
    await k.db.query(`insert into streams (stream, next_seq) values ('project:old', 2)`);

    const [ev] = await k.log.readStream("project:old");
    assert.equal(ev.type, "task.moved.v2", "reader sees the current type");
    assert.deepEqual(ev.payload, { taskId: "T1", to: "done", from: null });
  });

  test("causation and correlation chain a user action to its consequences", async () => {
    const root = await k.log.append({
      ...SCOPE,
      stream: "project:chain",
      type: "task.created",
      payload: { taskId: "C1", title: "c", state: "todo" },
      actor: USER,
    });
    await k.log.append({
      ...SCOPE,
      stream: "project:chain",
      type: "task.assigned",
      payload: { taskId: "C1", assigneeKind: "agent", assigneeId: "sess-1" },
      actor: { kind: "system", id: "automation" },
      causationId: root.id,
      correlationId: root.id,
    });
    const r = await k.db.query<{ n: string }>(
      `select count(*)::text as n from events where correlation_id = $1`,
      [root.id],
    );
    assert.equal(Number(r.rows[0].n), 1);
  });
});

describe("event log atomicity", () => {
  test("a rolled-back transaction leaves no event and no outbox row", async () => {
    const mem = await openMemoryDb();
    const k = await createKernel(mem.db);
    defineBoardEvents(k.registry);
    k.log.subscribe({ destination: "webhook:acme", match: "task.*" });

    const before = await k.log.count();
    await assert.rejects(() =>
      k.db.tx(async (tx) => {
        await k.log.append(
          {
            ...SCOPE,
            stream: "project:atomic",
            type: "task.created",
            payload: { taskId: "A1", title: "a", state: "todo" },
            actor: USER,
          },
          tx,
        );
        throw new Error("business rule failed after the event was appended");
      }),
    );

    assert.equal(await k.log.count(), before, "event rolled back with the caller's work");
    const ob = await mem.db.query<{ n: string }>(`select count(*)::text as n from outbox`);
    assert.equal(Number(ob.rows[0].n), 0, "outbox row rolled back too");
    await mem.close();
  });
});
