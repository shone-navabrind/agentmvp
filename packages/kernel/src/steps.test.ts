import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { openMemoryDb } from "./db.ts";
import { createKernel, type Kernel } from "./kernel.ts";
import { SCOPE } from "./fixtures.ts";
import { AmbiguousStep, type Db } from "./types.ts";
import { BudgetExceeded, type FlowDefinition } from "./steps.ts";

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
  const k = await createKernel(mem.db, { leaseMs: 1000 });
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
