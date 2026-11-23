import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { openMemoryDb } from "./db.ts";
import { createKernel } from "./kernel.ts";
import { defineBoardEvents, SCOPE, USER } from "./fixtures.ts";
import { Outbox, type Delivery } from "./outbox.ts";
import { LocalMasterKey, Secrets } from "./secrets.ts";

async function setup() {
  const mem = await openMemoryDb();
  const k = await createKernel(mem.db);
  defineBoardEvents(k.registry);
  return { mem, k };
}

describe("transactional outbox", () => {
  test("only subscribed event types are enqueued", async () => {
    const { mem, k } = await setup();
    k.log.subscribe({ destination: "webhook:acme", match: "task.moved.*" });

    await k.log.append({
      ...SCOPE, stream: "s", type: "task.created",
      payload: { taskId: "T1", title: "t", state: "todo" }, actor: USER,
    });
    await k.log.append({
      ...SCOPE, stream: "s", type: "task.moved.v2",
      payload: { taskId: "T1", from: "todo", to: "doing" }, actor: USER,
    });

    const ob = new Outbox(mem.db, k.log);
    assert.equal(await ob.pending(), 1, "task.created did not match the subscription");
    await mem.close();
  });

  test("one event fans out to every matching destination", async () => {
    const { mem, k } = await setup();
    k.log.subscribe({ destination: "webhook:acme", match: "*" });
    k.log.subscribe({ destination: "slack:eng", match: "task.*" });

    await k.log.append({
      ...SCOPE, stream: "s", type: "task.created",
      payload: { taskId: "T1", title: "t", state: "todo" }, actor: USER,
    });

    const ob = new Outbox(mem.db, k.log);
    const seen: string[] = [];
    const res = await ob.drain(async (d: Delivery) => {
      seen.push(d.destination);
      return { ok: true };
    });
    assert.equal(res.delivered, 2);
    assert.deepEqual(seen.sort(), ["slack:eng", "webhook:acme"]);
    assert.equal(await ob.pending(), 0);
    await mem.close();
  });

  test("delivery carries the full upcast event, not raw stored JSON", async () => {
    const { mem, k } = await setup();
    k.log.subscribe({ destination: "webhook:acme", match: "*" });
    await k.log.append({
      ...SCOPE, stream: "s", type: "task.created",
      payload: { taskId: "T1", title: "t", state: "todo" }, actor: USER,
      correlationId: "corr-1",
    });

    const ob = new Outbox(mem.db, k.log);
    const got: Delivery[] = [];
    await ob.drain(async (d) => {
      got.push(d);
      return { ok: true };
    });
    assert.equal(got.length, 1);
    assert.equal(got[0].event.type, "task.created");
    assert.equal(got[0].event.correlationId, "corr-1");
    assert.deepEqual(got[0].event.actor, USER);
    await mem.close();
  });

  test("a failing destination retries with backoff, then dead-letters", async () => {
    const { mem, k } = await setup();
    k.log.subscribe({ destination: "webhook:broken", match: "*" });
    await k.log.append({
      ...SCOPE, stream: "s", type: "task.created",
      payload: { taskId: "T1", title: "t", state: "todo" }, actor: USER,
    });

    const ob = new Outbox(mem.db, k.log, { maxAttempts: 3, backoffMs: () => 0 });
    const fail = async () => ({ ok: false as const, error: "502 Bad Gateway", retry: true });

    assert.deepEqual(await ob.drain(fail), { delivered: 0, retried: 1, dead: 0 });
    assert.deepEqual(await ob.drain(fail), { delivered: 0, retried: 1, dead: 0 });
    assert.deepEqual(await ob.drain(fail), { delivered: 0, retried: 0, dead: 1 });

    const dead = await ob.deadLettered();
    assert.equal(dead.length, 1);
    assert.equal(dead[0].last_error, "502 Bad Gateway");
    assert.equal(await ob.pending(), 0, "a dead letter is not retried forever");
    await mem.close();
  });

  test("a thrown delivery handler is treated as a retryable failure", async () => {
    const { mem, k } = await setup();
    k.log.subscribe({ destination: "webhook:throws", match: "*" });
    await k.log.append({
      ...SCOPE, stream: "s", type: "task.created",
      payload: { taskId: "T1", title: "t", state: "todo" }, actor: USER,
    });
    const ob = new Outbox(mem.db, k.log, { maxAttempts: 5, backoffMs: () => 0 });
    const res = await ob.drain(async () => {
      throw new Error("connection reset");
    });
    assert.deepEqual(res, { delivered: 0, retried: 1, dead: 0 });
    await mem.close();
  });

  test("backoff defers the next attempt", async () => {
    const { mem, k } = await setup();
    k.log.subscribe({ destination: "webhook:slow", match: "*" });
    await k.log.append({
      ...SCOPE, stream: "s", type: "task.created",
      payload: { taskId: "T1", title: "t", state: "todo" }, actor: USER,
    });
    const now = new Date();
    const ob = new Outbox(mem.db, k.log, { maxAttempts: 5, backoffMs: () => 60_000 });
    await ob.drain(async () => ({ ok: false, error: "503", retry: true }), { now });
    assert.equal(await ob.pending(now), 0, "not due yet");
    assert.equal(await ob.pending(new Date(now.getTime() + 61_000)), 1, "due after backoff");
    await mem.close();
  });
});

describe("secrets", () => {
  test("round-trips a value and stores no plaintext", async () => {
    const mem = await openMemoryDb();
    const k = await createKernel(mem.db, { keyWrapper: new LocalMasterKey(randomBytes(32)) });
    const value = "sk-ant-super-secret-value-12345";
    await k.secrets.put("secret://ws1/anthropic", "t1", value);

    assert.equal(await k.secrets.get("secret://ws1/anthropic"), value);
    const raw = await k.secrets.rawRow("secret://ws1/anthropic");
    assert.ok(!raw.includes("sk-ant"), "the database alone leaks nothing");
    await mem.close();
  });

  test("each record gets its own data key", async () => {
    const mem = await openMemoryDb();
    const k = await createKernel(mem.db);
    await k.secrets.put("secret://ws1/a", "t1", "same-value");
    await k.secrets.put("secret://ws1/b", "t1", "same-value");
    const a = await mem.db.query<{ wrapped_key: Uint8Array; ciphertext: Uint8Array }>(
      `select wrapped_key, ciphertext from secrets order by uri`,
    );
    assert.notDeepEqual(
      Buffer.from(a.rows[0].wrapped_key),
      Buffer.from(a.rows[1].wrapped_key),
      "identical plaintext must not produce identical keys",
    );
    assert.notDeepEqual(Buffer.from(a.rows[0].ciphertext), Buffer.from(a.rows[1].ciphertext));
    await mem.close();
  });

  test("a tampered ciphertext fails authentication rather than returning garbage", async () => {
    const mem = await openMemoryDb();
    const k = await createKernel(mem.db);
    await k.secrets.put("secret://ws1/t", "t1", "original");
    await mem.db.query(`update secrets set ciphertext = $1 where uri = 'secret://ws1/t'`, [
      Buffer.from("tampered-bytes!!"),
    ]);
    await assert.rejects(() => k.secrets.get("secret://ws1/t"));
    await mem.close();
  });

  test("rotating the master key is a re-wrap, not a re-encrypt", async () => {
    const mem = await openMemoryDb();
    const oldKey = new LocalMasterKey(randomBytes(32));
    const k = await createKernel(mem.db, { keyWrapper: oldKey });
    await k.secrets.put("secret://ws1/r", "t1", "value-to-keep");

    const before = await mem.db.query<{ ciphertext: Uint8Array }>(
      `select ciphertext from secrets where uri = 'secret://ws1/r'`,
    );
    const newKey = new LocalMasterKey(randomBytes(32));
    const row = await mem.db.query<{ wrapped_key: Uint8Array }>(
      `select wrapped_key from secrets where uri = 'secret://ws1/r'`,
    );
    const dataKey = await oldKey.unwrap(Buffer.from(row.rows[0].wrapped_key));
    await mem.db.query(`update secrets set wrapped_key = $1 where uri = 'secret://ws1/r'`, [
      await newKey.wrap(dataKey),
    ]);

    const after = await mem.db.query<{ ciphertext: Uint8Array }>(
      `select ciphertext from secrets where uri = 'secret://ws1/r'`,
    );
    assert.deepEqual(
      Buffer.from(before.rows[0].ciphertext),
      Buffer.from(after.rows[0].ciphertext),
      "the payload was never re-encrypted",
    );
    const rotated = new Secrets(mem.db, newKey);
    assert.equal(await rotated.get("secret://ws1/r"), "value-to-keep");
    await mem.close();
  });
});
