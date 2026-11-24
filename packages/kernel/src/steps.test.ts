import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { openMemoryDb } from "./db.ts";
import { createKernel, type Kernel } from "./kernel.ts";
import { SCOPE } from "./fixtures.ts";
import { AmbiguousStep, StepHeldElsewhere, type Db } from "./types.ts";
import { BudgetExceeded, type FlowDefinition } from "./steps.ts";
import { Worker } from "./worker.ts";

type ProvisionOut = { vmId: string; cert: string; bundles: number };

/** A provisioning state machine, which is exactly what the runtime exists to run. */
function provisionFlow(opts: {
  sideEffects: string[];
  crashAfter?: string | null;
}): FlowDefinition<{ projectId: string }, ProvisionOut> {
  return {
    kind: "provision",
    maxAttempts: 5,
    async run(ctx, input) {
      const vm = await ctx.step("allocate-vm", async () => {
        opts.sideEffects.push("allocate-vm");
        return { vmId: `vm-${input.projectId}` };
      });
      await ctx.emit("provision.progress", { step: "allocating" });

      const enrolled = await ctx.step("enroll", async () => {
        opts.sideEffects.push("enroll");
        return { cert: "fp-abc123" };
      });
      if (opts.crashAfter === "enroll") throw new Error("worker process died");

      const bundles = await ctx.step("apply-bundles", async () => {
        opts.sideEffects.push("apply-bundles");
        return { applied: 3 };
      });

      return { vmId: vm.vmId, cert: enrolled.cert, bundles: bundles.applied };
    },
  };
}

async function newKernel(): Promise<{ k: Kernel; db: Db; close: () => Promise<void> }> {
  const mem = await openMemoryDb();
  const k = await createKernel(mem.db, { ephemeralSecrets: true, leaseMs: 1000 });
  k.registry.define({
    type: "provision.progress",
    schema: z.object({ step: z.string() }),
  });
  k.registry.define({ type: "work.done", schema: z.object({ n: z.number() }) });
  return { k, db: mem.db, close: mem.close };
}

describe("durable step runtime", () => {
  test("K1 ACCEPTANCE: a run killed mid-flight resumes and produces identical output", async () => {
    // --- Reference: one clean, uninterrupted run. ---
    const cleanFx: string[] = [];
    const a = await newKernel();
    a.k.steps.register(provisionFlow({ sideEffects: cleanFx }));
    const cleanRunId = await a.k.steps.start("provision", { projectId: "p1" }, SCOPE);
    const clean = await a.k.steps.execute(cleanRunId);

    assert.equal(clean.state, "completed");
    assert.deepEqual(cleanFx, ["allocate-vm", "enroll", "apply-bundles"]);

    // --- Same flow, worker dies after enrolment. ---
    const crashFx: string[] = [];
    const opts = { sideEffects: crashFx, crashAfter: "enroll" as string | null };
    const b = await newKernel();
    b.k.steps.register(provisionFlow(opts));
    const runId = await b.k.steps.start("provision", { projectId: "p1" }, SCOPE);

    const interrupted = await b.k.steps.execute(runId);
    assert.equal(interrupted.state, "queued", "retryable, not failed");
    assert.deepEqual(crashFx, ["allocate-vm", "enroll"], "two side effects ran before the crash");

    // --- Another worker picks it up. ---
    opts.crashAfter = null;
    const resumed = await b.k.steps.execute(runId);

    assert.equal(resumed.state, "completed");
    assert.deepEqual(
      resumed.output,
      clean.output,
      "resumed output must be identical to the uninterrupted run",
    );
    assert.deepEqual(
      crashFx,
      ["allocate-vm", "enroll", "apply-bundles"],
      "completed steps replayed from stored results; only the remaining step executed",
    );
    assert.equal(resumed.attempt, 2);

    const steps = await b.k.steps.steps(runId);
    assert.deepEqual(
      steps.map((s) => [s.step_key, s.state]),
      [
        ["allocate-vm", "completed"],
        ["enroll", "completed"],
        ["apply-bundles", "completed"],
      ],
    );

    await a.close();
    await b.close();
  });

  test("a dead worker's run is discoverable by lease expiry", async () => {
    const { k, db, close } = await newKernel();
    k.steps.register(provisionFlow({ sideEffects: [] }));
    const runId = await k.steps.start("provision", { projectId: "p2" }, SCOPE);

    // Simulate a process that claimed the run and then vanished.
    await db.query(
      `update flow_runs set state='running', lease_until=$2, attempt=1 where id=$1`,
      [runId, new Date(Date.now() - 60_000).toISOString()],
    );

    assert.deepEqual(await k.steps.recoverable(), [runId]);
    const recovered = await k.steps.execute(runId);
    assert.equal(recovered.state, "completed");
    assert.deepEqual(await k.steps.recoverable(), [], "no longer orphaned");
    await close();
  });

  test("an interrupted non-idempotent step refuses to retry instead of double-charging", async () => {
    const { k, close } = await newKernel();
    let charges = 0;
    k.steps.register({
      kind: "charge",
      maxAttempts: 5,
      async run(ctx) {
        return ctx.step(
          "charge-card",
          async () => {
            charges++;
            throw new Error("network died after the provider received the request");
          },
          { idempotent: false },
        );
      },
    });

    const runId = await k.steps.start("charge", {}, SCOPE);
    const first = await k.steps.execute(runId);
    assert.equal(first.state, "queued");
    assert.equal(charges, 1);

    const second = await k.steps.execute(runId);
    assert.equal(second.state, "failed", "terminal: a human must resolve it");
    assert.equal((second.error as { code: string }).code, "AMBIGUOUS_STEP");
    assert.equal(charges, 1, "the side effect was never repeated");
    await close();
  });

  test("idempotent steps do retry after a transient failure", async () => {
    const { k, close } = await newKernel();
    let attempts = 0;
    k.steps.register({
      kind: "flaky",
      maxAttempts: 5,
      async run(ctx) {
        return ctx.step("call-api", async () => {
          attempts++;
          if (attempts < 3) throw new Error("503");
          return { ok: true };
        });
      },
    });
    const runId = await k.steps.start("flaky", {}, SCOPE);
    let rec = await k.steps.execute(runId);
    rec = await k.steps.execute(runId);
    rec = await k.steps.execute(runId);
    assert.equal(rec.state, "completed");
    assert.deepEqual(rec.output, { ok: true });
    assert.equal(attempts, 3);
    await close();
  });

  test("a run stops being retried at maxAttempts", async () => {
    const { k, close } = await newKernel();
    k.steps.register({
      kind: "doomed",
      maxAttempts: 2,
      async run(ctx) {
        return ctx.step("never-works", async () => {
          throw new Error("permanent");
        });
      },
    });
    const runId = await k.steps.start("doomed", {}, SCOPE);
    assert.equal((await k.steps.execute(runId)).state, "queued");
    assert.equal((await k.steps.execute(runId)).state, "failed");
    assert.equal((await k.steps.execute(runId)).state, "failed", "terminal state is sticky");
    await close();
  });

  test("a cost guard is not reset by resumption", async () => {
    // Spend lived in memory per execute(), so a run with maxAttempts N could spend
    // its cap N times over. The guard has to remember across attempts.
    const { k, close } = await newKernel();
    let turns = 0;
    k.steps.register({
      kind: "expensive",
      maxAttempts: 4,
      async run(ctx) {
        for (let i = 0; i < 100; i++) {
          turns++;
          await ctx.step(`turn-${ctx.attempt}-${i}`, async () => ({ i }));
          ctx.budget.charge(0.05);
          ctx.budget.assertUnder(0.2);
        }
        return { done: true };
      },
    });

    const runId = await k.steps.start("expensive", {}, SCOPE);
    await k.steps.execute(runId);
    const afterFirst = turns;
    assert.equal(afterFirst, 4, "stopped at $0.20 on the first attempt");

    // BudgetExceeded is non-retryable, so the run is already terminal; the point is
    // that the recorded spend survived rather than resetting to zero.
    const rec = await k.steps.get(runId);
    assert.equal(rec!.state, "failed");
    assert.ok((rec!.spentUsd ?? 0) >= 0.2, `spend persisted, got ${rec!.spentUsd}`);
    await close();
  });

  test("a loop halts on the cost guard instead of draining the wallet", async () => {
    const { k, close } = await newKernel();
    let iterations = 0;
    k.steps.register({
      kind: "agent-loop",
      maxAttempts: 1,
      async run(ctx) {
        for (let i = 0; i < 1000; i++) {
          iterations++;
          await ctx.step(`turn-${i}`, async () => ({ i }));
          ctx.budget.charge(0.02);
          ctx.budget.assertUnder(0.1); // $0.10 cap
        }
        return { ran: "to completion" };
      },
    });
    const runId = await k.steps.start("agent-loop", {}, SCOPE);
    const rec = await k.steps.execute(runId);
    assert.equal(rec.state, "failed");
    assert.equal((rec.error as { code: string }).code, "BUDGET_EXCEEDED");
    assert.equal(iterations, 5, "halted at $0.10, not after 1000 turns");
    await close();
  });

  test("flow emissions land on the run's own stream, correlated to the run", async () => {
    const { k, close } = await newKernel();
    k.steps.register(provisionFlow({ sideEffects: [] }));
    const runId = await k.steps.start("provision", { projectId: "p3" }, SCOPE);
    await k.steps.execute(runId);

    const evs = await k.log.readStream(`flowrun:${runId}`);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].type, "provision.progress");
    assert.equal(evs[0].correlationId, runId);
    assert.deepEqual(evs[0].actor, { kind: "system", id: "flow:provision" });
    await close();
  });

  test("emissions outside a step replay on resume -- so once-only emits go inside one", async () => {
    const { k, close } = await newKernel();
    const opts = { sideEffects: [] as string[], crashAfter: "enroll" as string | null };
    k.steps.register(provisionFlow(opts));
    const runId = await k.steps.start("provision", { projectId: "p4" }, SCOPE);
    await k.steps.execute(runId);
    opts.crashAfter = null;
    await k.steps.execute(runId);

    const evs = await k.log.readStream(`flowrun:${runId}`);
    assert.equal(evs.length, 2, "documented behaviour: ctx.emit is not memoised, ctx.step is");
    await close();
  });

  test("unknown flow kinds are rejected at start, not at execute", async () => {
    const { k, close } = await newKernel();
    await assert.rejects(() => k.steps.start("does-not-exist", {}, SCOPE), /Unknown flow kind/);
    await close();
  });
});

describe("D5: two executors must not both run one side effect", () => {
  test("concurrent executors on the same run claim each step exactly once", async () => {
    const { k, close } = await newKernel();
    const charges: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));

    k.steps.register({
      kind: "charge-once",
      maxAttempts: 1,
      async run(ctx) {
        return ctx.step(
          "charge-card",
          async () => {
            charges.push(`attempt-${ctx.attempt}`);
            await gate; // hold the step open so both executors overlap
            return { charged: true };
          },
          { idempotent: false },
        );
      },
    });

    const runId = await k.steps.start("charge-once", {}, SCOPE);

    // Two executors race on the same run, which is exactly what an expired lease
    // produces in production.
    const a = k.steps.execute(runId);
    await new Promise((r) => setTimeout(r, 60));
    const b = k.steps.execute(runId);
    release();
    const [ra, rb] = await Promise.all([a, b]);

    assert.equal(charges.length, 1, `the side effect ran ${charges.length} times, expected 1`);
    const states = [ra.state, rb.state];
    assert.ok(states.includes("completed"), "one executor finished the run");
    await close();
  });

  test("the loser is told it is held elsewhere, and that is retryable", () => {
    const e = new StepHeldElsewhere("run-1", "charge-card");
    assert.equal(e.code, "STEP_HELD_ELSEWHERE");
    assert.equal(e.retryable, true, "the run can be picked up again once the holder finishes");
  });

  test("a completed step is never re-claimed, only replayed", async () => {
    const { k, close } = await newKernel();
    let ran = 0;
    k.steps.register({
      kind: "memo",
      maxAttempts: 3,
      async run(ctx) {
        const first = await ctx.step("once", async () => {
          ran++;
          return { n: ran };
        });
        if (ctx.attempt === 1) throw new Error("crash after the first step");
        return first;
      },
    });
    const runId = await k.steps.start("memo", {}, SCOPE);
    await k.steps.execute(runId);
    const done = await k.steps.execute(runId);
    assert.equal(ran, 1, "replayed from the stored result rather than re-claimed");
    assert.deepEqual(done.output, { n: 1 });
    await close();
  });
});

describe("AmbiguousStep", () => {
  test("carries the run and step so an operator can act on it", () => {
    const e = new AmbiguousStep("run-1", "charge-card");
    assert.equal(e.code, "AMBIGUOUS_STEP");
    assert.deepEqual(e.details, { runId: "run-1", stepKey: "charge-card" });
  });
});

describe("BudgetExceeded", () => {
  test("reports spend and limit", () => {
    const e = new BudgetExceeded(0.12, 0.1);
    assert.equal(e.code, "BUDGET_EXCEEDED");
    assert.deepEqual(e.details, { spent: 0.12, limit: 0.1 });
  });
});

describe("D4: a worker drives runs, and a dead one is recovered", () => {
  test("a queued run is claimed and executed without anyone calling execute()", async () => {
    const { k, db, close } = await newKernel();
    const ran: string[] = [];
    k.steps.register({
      kind: "background",
      async run(ctx) {
        ran.push(ctx.runId);
        return ctx.step("work", async () => ({ ok: true }));
      },
    });

    const runId = await k.steps.start("background", {}, SCOPE);
    const w = new Worker(db, k.steps, { concurrency: 2 });

    assert.equal(await w.tick(), 1, "the worker found and ran it");
    assert.deepEqual(ran, [runId]);
    assert.equal((await k.steps.get(runId))!.state, "completed");
    assert.equal(w.stats.completed, 1);
    await close();
  });

  test("two workers never claim the same run", async () => {
    const { k, db, close } = await newKernel();
    const ran: string[] = [];
    k.steps.register({
      kind: "once-only",
      async run(ctx) {
        ran.push(ctx.runId);
        return ctx.step("w", async () => ({ ok: true }));
      },
    });
    for (let i = 0; i < 6; i++) await k.steps.start("once-only", {}, SCOPE);

    const a = new Worker(db, k.steps, { concurrency: 3 });
    const b = new Worker(db, k.steps, { concurrency: 3 });
    await Promise.all([a.tick(), b.tick()]);

    assert.equal(ran.length, new Set(ran).size, "no run was executed twice");
    assert.equal(a.stats.claimed + b.stats.claimed, ran.length);
    await close();
  });

  test("a run abandoned by a dead worker is reclaimed", async () => {
    const { k, db, close } = await newKernel();
    k.steps.register({
      kind: "orphaned",
      async run(ctx) {
        return ctx.step("w", async () => ({ ok: true }));
      },
    });
    const runId = await k.steps.start("orphaned", {}, SCOPE);

    // Simulate a worker that claimed the run and then vanished.
    await db.query(`update flow_runs set state='running', lease_until=$2 where id=$1`, [
      runId,
      new Date(Date.now() - 60_000).toISOString(),
    ]);

    const w = new Worker(db, k.steps);
    assert.equal(await w.tick(), 1, "the expired lease was reclaimed");
    assert.equal((await k.steps.get(runId))!.state, "completed");
    await close();
  });

  test("a live run's lease is renewed, so it is not stolen mid-flight", async () => {
    const { k, db, close } = await newKernel();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    k.steps.register({
      kind: "slow",
      async run(ctx) {
        return ctx.step("slow-work", async () => {
          await gate;
          return { ok: true };
        });
      },
    });
    const runId = await k.steps.start("slow", {}, SCOPE);

    // A 200ms lease renewed every 50ms: without renewal it would expire mid-run.
    const w = new Worker(db, k.steps, { renewMs: 50, concurrency: 1 });
    const inFlight = w.tick(200);
    await new Promise((r) => setTimeout(r, 320));

    const thief = new Worker(db, k.steps);
    assert.equal(await thief.claimOne(200), null, "nobody could steal the live run");
    assert.ok(w.stats.renewals >= 2, `lease was renewed (${w.stats.renewals} times)`);

    release();
    await inFlight;
    assert.equal((await k.steps.get(runId))!.state, "completed");
    await close();
  });

  test("start/stop runs the loop and drains cleanly", async () => {
    const { k, db, close } = await newKernel();
    k.steps.register({
      kind: "looped",
      async run(ctx) {
        return ctx.step("w", async () => ({ ok: true }));
      },
    });
    const w = new Worker(db, k.steps, { pollMs: 20 });
    w.start();
    const runId = await k.steps.start("looped", {}, SCOPE);
    for (let i = 0; i < 50 && (await k.steps.get(runId))!.state !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await w.stop();
    assert.equal((await k.steps.get(runId))!.state, "completed");
    assert.deepEqual(w.inFlight, []);
    await close();
  });
});

describe("D6: a run is pinned to the definition it started with", () => {
  const graphV1 = { name: "release", nodes: [{ id: "a" }], edges: [] };
  const graphV2 = { name: "release", nodes: [{ id: "a" }, { id: "b" }], edges: [] };

  test("publishing the same definition twice does not create a second version", async () => {
    const { k, close } = await newKernel();
    const a = await k.steps.publish("graph:release", graphV1);
    const b = await k.steps.publish("graph:release", graphV1);
    assert.equal(a.id, b.id);
    assert.equal(a.version, 1);
    await close();
  });

  test("editing the definition creates a new version and leaves the old run on the old one", async () => {
    const { k, close } = await newKernel();
    k.steps.register({ kind: "graph:release", async run() { return { ok: true }; } });

    await k.steps.publish("graph:release", graphV1);
    const oldRun = await k.steps.start("graph:release", {}, SCOPE);

    const v2 = await k.steps.publish("graph:release", graphV2);
    assert.equal(v2.version, 2);
    const newRun = await k.steps.start("graph:release", {}, SCOPE);

    const pinnedOld = await k.steps.pinnedDefinition(oldRun);
    const pinnedNew = await k.steps.pinnedDefinition(newRun);
    assert.equal(pinnedOld!.version, 1, "the in-flight run still sees v1");
    assert.equal(pinnedNew!.version, 2);
    assert.deepEqual(pinnedOld!.graph, graphV1);
    await close();
  });

  test("the pinned graph is stored, so a run is resumable without the author's code", async () => {
    const { k, close } = await newKernel();
    k.steps.register({ kind: "graph:release", async run() { return { ok: true }; } });
    await k.steps.publish("graph:release", graphV1);
    const runId = await k.steps.start("graph:release", {}, SCOPE);

    const pinned = await k.steps.pinnedDefinition(runId);
    assert.deepEqual(pinned!.graph, graphV1, "the definition came from the database, not memory");
    await close();
  });

  test("a digest change is what makes a new version, not a republish", async () => {
    const { k, close } = await newKernel();
    const a = await k.steps.publish("graph:x", { a: 1 });
    const b = await k.steps.publish("graph:x", { a: 2 });
    const c = await k.steps.publish("graph:x", { a: 1 });
    assert.notEqual(a.digest, b.digest);
    assert.equal(a.id, c.id, "identical content reuses the existing version");
    await close();
  });
});
