import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { openMemoryDb } from "@harness/kernel";
import { Ledger, microsToUsd, usdToMicros } from "./ledger.ts";
import { BudgetEnforcer, type GatewayAdmin, type GatewayKey } from "./budget.ts";

async function setup() {
  const mem = await openMemoryDb();
  const ledger = new Ledger(mem.db);
  await ledger.migrate();
  return { mem, ledger };
}

const KEY: GatewayKey = {
  projectId: "p1",
  workspaceId: "ws1",
  litellmKeyId: "sk-proj-1",
  maxBudgetUsd: 50,
  models: ["claude-sonnet-5-5"],
};

function fakeGateway(spend: Array<{ keyId: string; usd: number; windowId: string }> = []): GatewayAdmin & {
  budgets: Record<string, number>;
  revoked: string[];
} {
  const budgets: Record<string, number> = {};
  const revoked: string[] = [];
  return {
    budgets,
    revoked,
    async setKeyBudget(keyId, usd) {
      budgets[keyId] = usd;
    },
    async revokeKey(keyId) {
      revoked.push(keyId);
    },
    async pullSpend() {
      return spend;
    },
  };
}

describe("ledger arithmetic", () => {
  test("money is integer micro-units, so no float drift accumulates", async () => {
    const { mem, ledger } = await setup();
    await ledger.grant("ws1", 10, "g1");
    // 1000 debits of $0.001 -- floats would drift here.
    for (let i = 0; i < 1000; i++) {
      await ledger.debit({ workspaceId: "ws1", usd: 0.001, idemKey: `d${i}` });
    }
    assert.equal(await ledger.balance("ws1"), usdToMicros(9));
    assert.equal(microsToUsd(await ledger.balance("ws1")), 9);
    await mem.close();
  });

  test("the balance always equals the sum of billable entries", async () => {
    const { mem, ledger } = await setup();
    await ledger.grant("ws1", 100, "g1");
    await ledger.debit({ workspaceId: "ws1", usd: 12.345678, idemKey: "d1" });
    await ledger.debit({ workspaceId: "ws1", usd: 0.000001, idemKey: "d2" });
    const r = await ledger.reconcile("ws1");
    assert.equal(r.drift, 0, "no drift between the wallet and its entries");
    await mem.close();
  });

  test("a replayed spend-sync cannot double-charge", async () => {
    const { mem, ledger } = await setup();
    await ledger.grant("ws1", 10, "g1");

    const first = await ledger.debit({ workspaceId: "ws1", usd: 3, idemKey: "spend:k1:w1" });
    assert.equal(first.applied, true);

    const replay = await ledger.debit({ workspaceId: "ws1", usd: 3, idemKey: "spend:k1:w1" });
    assert.equal(replay.applied, false);
    assert.equal(replay.balanceMicros, first.balanceMicros);
    assert.equal(await ledger.balance("ws1"), usdToMicros(7));
    await mem.close();
  });

  test("a repeated grant with the same key is applied once", async () => {
    const { mem, ledger } = await setup();
    await ledger.grant("ws1", 25, "promo-2026");
    await ledger.grant("ws1", 25, "promo-2026");
    assert.equal(await ledger.balance("ws1"), usdToMicros(25));
    await mem.close();
  });

  test("BYOK spend is recorded for visibility but never charged", async () => {
    const { mem, ledger } = await setup();
    await ledger.grant("ws1", 10, "g1");
    await ledger.debit({ workspaceId: "ws1", usd: 7, idemKey: "byok1", billable: false });

    assert.equal(await ledger.balance("ws1"), usdToMicros(10), "balance untouched");
    const entries = await ledger.entries("ws1");
    assert.equal(entries.length, 2);
    assert.equal(entries[1].billable, false, "but the spend is on the record");
    await mem.close();
  });

  test("spend is attributable per project", async () => {
    const { mem, ledger } = await setup();
    await ledger.grant("ws1", 100, "g1");
    await ledger.debit({ workspaceId: "ws1", projectId: "p1", usd: 4, idemKey: "a" });
    await ledger.debit({ workspaceId: "ws1", projectId: "p2", usd: 1.5, idemKey: "b" });
    await ledger.debit({ workspaceId: "ws1", projectId: "p1", usd: 2, idemKey: "c" });

    assert.deepEqual(await ledger.spendByProject("ws1"), {
      p1: usdToMicros(6),
      p2: usdToMicros(1.5),
    });
    await mem.close();
  });
});

describe("budget enforcement", () => {
  test("the gateway cap tracks the remaining balance", async () => {
    const { mem, ledger } = await setup();
    const gw = fakeGateway();
    const b = new BudgetEnforcer({ ledger, gateway: gw });

    await ledger.grant("ws1", 20, "g1");
    await b.pushBudgets("ws1", [KEY]);
    assert.equal(gw.budgets["sk-proj-1"], 20, "capped by balance, below the key's own ceiling");

    await ledger.grant("ws1", 100, "g2");
    await b.pushBudgets("ws1", [KEY]);
    assert.equal(gw.budgets["sk-proj-1"], 50, "now capped by the key's own ceiling");
    await mem.close();
  });

  test("at zero balance the key's budget is zero, so the gateway itself refuses", async () => {
    const { mem, ledger } = await setup();
    const gw = fakeGateway();
    const b = new BudgetEnforcer({ ledger, gateway: gw });

    await ledger.grant("ws1", 5, "g1");
    await ledger.debit({ workspaceId: "ws1", usd: 5, idemKey: "d1" });

    const res = await b.pushBudgets("ws1", [KEY]);
    assert.deepEqual(res, { updated: 1, blocked: 1 });
    assert.equal(gw.budgets["sk-proj-1"], 0);

    const can = await b.canSpend("ws1");
    assert.equal(can.allowed, false);
    assert.match(can.reason!, /Add your own model key, or request credit/);
    await mem.close();
  });

  test("an overspent balance never pushes a negative cap", async () => {
    const { mem, ledger } = await setup();
    const gw = fakeGateway();
    const b = new BudgetEnforcer({ ledger, gateway: gw });

    await ledger.grant("ws1", 1, "g1");
    // An in-flight request lands after the cap: the ledger records the truth.
    await ledger.debit({ workspaceId: "ws1", usd: 3, idemKey: "late" });
    assert.equal(await ledger.balance("ws1"), usdToMicros(-2), "the overspend is recorded, not hidden");

    await b.pushBudgets("ws1", [KEY]);
    assert.equal(gw.budgets["sk-proj-1"], 0, "clamped at zero, never negative");
    await mem.close();
  });

  test("spend-sync is idempotent across repeated pulls of the same window", async () => {
    const { mem, ledger } = await setup();
    const gw = fakeGateway([{ keyId: "sk-proj-1", usd: 2.5, windowId: "2026-03-04T10:00" }]);
    const b = new BudgetEnforcer({ ledger, gateway: gw });
    await ledger.grant("ws1", 10, "g1");

    assert.deepEqual(await b.syncSpend([KEY]), { debited: 2.5, entries: 1 });
    assert.deepEqual(await b.syncSpend([KEY]), { debited: 0, entries: 0 }, "same window, no re-debit");
    assert.equal(await ledger.balance("ws1"), usdToMicros(7.5));
    await mem.close();
  });

  test("spend for an unknown key is ignored rather than mis-attributed", async () => {
    const { mem, ledger } = await setup();
    const gw = fakeGateway([{ keyId: "sk-unknown", usd: 99, windowId: "w1" }]);
    const b = new BudgetEnforcer({ ledger, gateway: gw });
    await ledger.grant("ws1", 10, "g1");
    assert.deepEqual(await b.syncSpend([KEY]), { debited: 0, entries: 0 });
    assert.equal(await ledger.balance("ws1"), usdToMicros(10));
    await mem.close();
  });

  test("alerts fire once at 80% and once at 100%", async () => {
    const { mem, ledger } = await setup();
    const b = new BudgetEnforcer({ ledger, gateway: fakeGateway() });
    await ledger.grant("ws1", 100, "g1");

    assert.deepEqual(await b.checkAlerts("ws1", 100), [], "nothing spent yet");

    await ledger.debit({ workspaceId: "ws1", usd: 85, idemKey: "d1" });
    const a1 = await b.checkAlerts("ws1", 100);
    assert.deepEqual(a1.map((a) => a.level), [80]);
    assert.deepEqual(await b.checkAlerts("ws1", 100), [], "not repeated");

    await ledger.debit({ workspaceId: "ws1", usd: 15, idemKey: "d2" });
    assert.deepEqual((await b.checkAlerts("ws1", 100)).map((a) => a.level), [100]);
    await mem.close();
  });
});
