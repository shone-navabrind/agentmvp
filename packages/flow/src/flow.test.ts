import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { openMemoryDb, createKernel, type Kernel } from "@harness/kernel";
import { NodeRegistry } from "./registry.ts";
import { compileGraph } from "./runner.ts";
import { defineNode, GraphInvalid, type Graph } from "./types.ts";
import { approvalNode, checkNode, constNode, incrementNode, mapNode, standardNodes } from "./nodes.ts";

const SCOPE = { tenantId: "t1", workspaceId: "ws1", projectId: "p1" };

async function kernelWith(graph: Graph, reg: NodeRegistry): Promise<{ k: Kernel; close: () => Promise<void> }> {
  const mem = await openMemoryDb();
  const k = await createKernel(mem.db);
  k.registry.define({ type: "flow.note", schema: z.object({ text: z.string() }) });
  k.steps.register(compileGraph(graph, reg));
  return { k, close: mem.close };
}

describe("graph validation (at save time, not run time)", () => {
  const reg = standardNodes();

  test("accepts a well-formed graph", () => {
    const g: Graph = {
      name: "ok",
      entry: "seed",
      nodes: [
        { id: "seed", type: "core.const", config: { value: 1 } },
        { id: "check", type: "core.check", input: { value: "$.nodes.seed.value" } },
      ],
      edges: [{ from: "seed", to: "check" }],
    };
    assert.deepEqual(reg.validate(g), { ok: true });
  });

  test("rejects a reference to a field the source node cannot produce", () => {
    const g: Graph = {
      name: "typo",
      entry: "seed",
      nodes: [
        { id: "seed", type: "core.const", config: { value: 1 } },
        { id: "check", type: "core.check", input: { value: "$.nodes.seed.valeu" } },
      ],
      edges: [{ from: "seed", to: "check" }],
    };
    const r = reg.validate(g);
    assert.equal(r.ok, false);
    assert.match(
      (r as { problems: string[] }).problems[0],
      /references "\$\.nodes\.seed\.valeu", which "core\.const" does not produce/,
    );
  });

  test("rejects a missing required input", () => {
    const g: Graph = {
      name: "missing",
      entry: "inc",
      nodes: [{ id: "inc", type: "core.increment" }], // needs `from: number`
      edges: [],
    };
    const r = reg.validate(g);
    assert.equal(r.ok, false);
    assert.match((r as { problems: string[] }).problems[0], /missing required input "from"/);
  });

  test("DOCUMENTED GOTCHA: a z.unknown() input key reads as optional to zod", () => {
    // core.check declares `value: z.unknown()`, and zod reports such keys as optional,
    // so the validator cannot demand it. Node authors who need a value present must
    // declare a concrete type (or z.any().refine(...)), not z.unknown().
    const g: Graph = {
      name: "unknown-optional",
      entry: "check",
      nodes: [{ id: "check", type: "core.check" }],
      edges: [],
    };
    assert.deepEqual(reg.validate(g), { ok: true });
  });

  test("rejects unregistered node types, bad config, unknown edges and unreachable nodes", () => {
    const g: Graph = {
      name: "messy",
      entry: "a",
      nodes: [
        { id: "a", type: "core.const", config: { value: 1 } },
        { id: "b", type: "does.not.exist" },
        { id: "orphan", type: "core.const", config: { value: 2 } },
      ],
      edges: [{ from: "a", to: "nowhere" }],
    };
    const r = reg.validate(g) as { ok: false; problems: string[] };
    assert.equal(r.ok, false);
    const joined = r.problems.join(" | ");
    assert.match(joined, /unregistered type "does\.not\.exist"/);
    assert.match(joined, /edge to unknown node "nowhere"/);
    assert.match(joined, /"orphan" is unreachable/);
  });

  test("rejects an unguarded cycle -- the wallet-draining loop", () => {
    const g: Graph = {
      name: "loop",
      entry: "a",
      nodes: [
        { id: "a", type: "core.const", config: { value: 1 } },
        { id: "b", type: "core.check", input: { value: "$.nodes.a.value" } },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    };
    const r = reg.validate(g) as { ok: false; problems: string[] };
    assert.match(r.problems.join(" "), /cycle but declares no guard/);
  });

  test("accepts the same cycle once a guard is declared", () => {
    const g: Graph = {
      name: "loop-guarded",
      entry: "a",
      guards: { maxSteps: 10 },
      nodes: [
        { id: "a", type: "core.const", config: { value: 1 } },
        { id: "b", type: "core.check", input: { value: "$.nodes.a.value" } },
      ],
      edges: [
        { from: "a", to: "b" },
        { from: "b", to: "a" },
      ],
    };
    assert.deepEqual(reg.validate(g), { ok: true });
  });

  test("compileGraph throws GraphInvalid rather than producing a broken flow", () => {
    assert.throws(
      () => compileGraph({ name: "bad", entry: "nope", nodes: [], edges: [] }, reg),
      GraphInvalid,
    );
  });

  test("a node cannot reference its own output", () => {
    const g: Graph = {
      name: "self",
      entry: "a",
      nodes: [{ id: "a", type: "core.check", input: { value: "$.nodes.a.value" } }],
      edges: [],
    };
    const r = reg.validate(g) as { ok: false; problems: string[] };
    assert.match(r.problems.join(" "), /references its own output/);
  });
});

describe("graph execution", () => {
  test("runs a linear graph and maps the declared output", async () => {
    const g: Graph = {
      name: "linear",
      entry: "seed",
      nodes: [
        { id: "seed", type: "core.const", config: { value: 41 } },
        { id: "inc", type: "core.increment", input: { from: "$.nodes.seed.value" } },
      ],
      edges: [{ from: "seed", to: "inc" }],
      output: { answer: "$.nodes.inc.n" },
    };
    const { k, close } = await kernelWith(g, standardNodes());
    const runId = await k.steps.start("graph:linear", {}, SCOPE);
    const rec = await k.steps.execute(runId);
    assert.equal(rec.state, "completed");
    assert.deepEqual((rec.output as { output: unknown }).output, { answer: 42 });
    assert.deepEqual((rec.output as { visited: string[] }).visited, ["seed", "inc"]);
    await close();
  });

  test("follows the first edge whose condition holds", async () => {
    const g: Graph = {
      name: "branch",
      entry: "check",
      nodes: [
        { id: "check", type: "core.check", input: { value: "$.input.flag" } },
        { id: "yes", type: "core.const", config: { value: "took-yes" } },
        { id: "no", type: "core.const", config: { value: "took-no" } },
      ],
      edges: [
        { from: "check", to: "yes", when: { op: "truthy", value: "$.nodes.check.truthy" } },
        { from: "check", to: "no" },
      ],
      output: { took: "$.nodes.yes.value" },
    };
    const { k, close } = await kernelWith(g, standardNodes());

    const a = await k.steps.execute(await k.steps.start("graph:branch", { flag: true }, SCOPE));
    assert.deepEqual((a.output as { visited: string[] }).visited, ["check", "yes"]);

    const b = await k.steps.execute(await k.steps.start("graph:branch", { flag: false }, SCOPE));
    assert.deepEqual((b.output as { visited: string[] }).visited, ["check", "no"]);
    await close();
  });

  test("loops until a condition clears, with the iteration counter in state", async () => {
    const g: Graph = {
      name: "countup",
      entry: "seed",
      guards: { maxSteps: 50 },
      nodes: [
        { id: "seed", type: "core.const", config: { value: 0 } },
        { id: "inc", type: "core.increment", input: { from: "$.nodes.inc.n" }, maxIterations: 20 },
      ],
      edges: [
        { from: "seed", to: "inc" },
        { from: "inc", to: "inc", when: { op: "lt", left: "$.nodes.inc.n", right: 5 } },
      ],
      output: { n: "$.nodes.inc.n", iterations: "$.iteration.inc" },
    };
    // `inc` reads its own previous output, which the validator forbids via $.nodes --
    // so this graph instead seeds from state. Rewritten below to stay legal.
    const legal: Graph = {
      ...g,
      nodes: [
        { id: "seed", type: "core.const", config: { value: 0 } },
        { id: "inc", type: "core.increment", input: { from: "$.state.n" }, maxIterations: 20 },
      ],
    };
    const reg = new NodeRegistry()
      .register(constNode)
      .register(
        defineNode({
          // a counter that carries its own state across iterations
          type: "core.increment",
          configSchema: z.object({ by: z.number().default(1) }),
          inputSchema: z.object({ from: z.unknown() }),
          outputSchema: z.object({ n: z.number() }),
          async execute(ctx, config, input) {
            return { n: (typeof input.from === "number" ? input.from : ctx.iteration) + config.by };
          },
        }),
      );
    const { k, close } = await kernelWith(legal, reg);
    const rec = await k.steps.execute(await k.steps.start("graph:countup", {}, SCOPE));
    assert.equal(rec.state, "completed");
    assert.equal((rec.output as { output: { n: number } }).output.n, 5);
    await close();
  });

  test("maxSteps halts a runaway loop", async () => {
    const g: Graph = {
      name: "runaway",
      entry: "a",
      guards: { maxSteps: 7 },
      nodes: [{ id: "a", type: "core.const", config: { value: 1 } }],
      edges: [{ from: "a", to: "a" }],
    };
    const { k, close } = await kernelWith(g, standardNodes());
    const rec = await k.steps.execute(await k.steps.start("graph:runaway", {}, SCOPE));
    assert.equal(rec.state, "failed");
    assert.equal((rec.error as { code: string }).code, "GUARD_TRIPPED");
    assert.equal((rec.error as { details: { guard: string } }).details.guard, "maxSteps");
    await close();
  });

  test("maxIterations halts a single hot node", async () => {
    const g: Graph = {
      name: "hotnode",
      entry: "a",
      nodes: [{ id: "a", type: "core.const", config: { value: 1 }, maxIterations: 3 }],
      edges: [{ from: "a", to: "a" }],
    };
    const { k, close } = await kernelWith(g, standardNodes());
    const rec = await k.steps.execute(await k.steps.start("graph:hotnode", {}, SCOPE));
    assert.equal((rec.error as { details: { guard: string } }).details.guard, "maxIterations");
    await close();
  });

  test("a mistyped value at a step boundary pauses with the actual vs expected shape", async () => {
    const reg = new NodeRegistry().register(constNode).register(incrementNode);
    const g: Graph = {
      name: "badtype",
      entry: "seed",
      nodes: [
        { id: "seed", type: "core.const", config: { value: "not-a-number" } },
        { id: "inc", type: "core.increment", input: { from: "$.nodes.seed.value" } },
      ],
      edges: [{ from: "seed", to: "inc" }],
    };
    const { k, close } = await kernelWith(g, reg);
    const rec = await k.steps.execute(await k.steps.start("graph:badtype", {}, SCOPE));
    assert.equal(rec.state, "failed");
    const err = rec.error as { code: string; details: { nodeId: string; received: unknown } };
    assert.equal(err.code, "STEP_INPUT_INVALID");
    assert.equal(err.details.nodeId, "inc");
    assert.deepEqual(err.details.received, { from: "not-a-number" });
    await close();
  });

  test("fan-out runs items concurrently, each as its own memoised sub-step", async () => {
    let concurrent = 0;
    let peak = 0;
    const reg = new NodeRegistry().register(constNode).register(
      mapNode("test.map", z.number(), z.number(), async (n) => {
        peak = Math.max(peak, ++concurrent);
        await new Promise((r) => setTimeout(r, 10));
        concurrent--;
        return n * 2;
      }),
    );
    const g: Graph = {
      name: "fanout",
      entry: "seed",
      nodes: [
        { id: "seed", type: "core.const", config: { value: [1, 2, 3, 4, 5, 6] } },
        { id: "double", type: "test.map", config: { concurrency: 3 }, input: { items: "$.nodes.seed.value" } },
      ],
      edges: [{ from: "seed", to: "double" }],
      output: { results: "$.nodes.double.results" },
    };
    const { k, close } = await kernelWith(g, reg);
    const rec = await k.steps.execute(await k.steps.start("graph:fanout", {}, SCOPE));
    assert.deepEqual((rec.output as { output: { results: number[] } }).output.results, [2, 4, 6, 8, 10, 12]);
    assert.equal(peak, 3, "concurrency limit respected");
    await close();
  });
});

describe("human in the loop", () => {
  test("an approval node parks the run, and resume() continues from exactly there", async () => {
    const sideEffects: string[] = [];
    const reg = new NodeRegistry()
      .register(constNode)
      .register(approvalNode)
      .register(
        defineNode({
          type: "test.deploy",
          configSchema: z.object({}),
          inputSchema: z.object({ decision: z.string() }),
          outputSchema: z.object({ deployed: z.boolean() }),
          async execute(_ctx, _cfg, input) {
            sideEffects.push(`deploy:${input.decision}`);
            return { deployed: input.decision === "approve" };
          },
        }),
      );

    const g: Graph = {
      name: "deploy",
      entry: "plan",
      nodes: [
        { id: "plan", type: "core.const", config: { value: "3 files changed" } },
        {
          id: "gate",
          type: "core.approval",
          config: { options: ["approve", "reject"] },
          input: { question: "Deploy to production?", context: "$.nodes.plan.value" },
        },
        { id: "deploy", type: "test.deploy", input: { decision: "$.nodes.gate.decision" } },
      ],
      edges: [
        { from: "plan", to: "gate" },
        { from: "gate", to: "deploy" },
      ],
      output: { deployed: "$.nodes.deploy.deployed" },
    };

    const { k, close } = await kernelWith(g, reg);
    const runId = await k.steps.start("graph:deploy", {}, SCOPE);

    const paused = await k.steps.execute(runId);
    assert.equal(paused.state, "paused", "waiting on a person is not a failure");
    assert.deepEqual(sideEffects, [], "nothing downstream ran");

    const inbox = await k.steps.awaitingDecision();
    assert.equal(inbox.length, 1);
    assert.deepEqual(inbox[0].question, {
      text: "Deploy to production?",
      options: ["approve", "reject"],
      meta: { nodeId: "gate", context: "3 files changed" },
    });

    await k.steps.resume(runId, "approval:gate", { decision: "approve", by: "u-admin" });
    const done = await k.steps.execute(runId);

    assert.equal(done.state, "completed");
    assert.deepEqual((done.output as { output: unknown }).output, { deployed: true });
    assert.deepEqual(sideEffects, ["deploy:approve"]);
    assert.deepEqual(await k.steps.awaitingDecision(), []);
    await close();
  });

  test("resuming a run that is not paused is refused", async () => {
    const g: Graph = {
      name: "plain",
      entry: "a",
      nodes: [{ id: "a", type: "core.const", config: { value: 1 } }],
      edges: [],
    };
    const { k, close } = await kernelWith(g, standardNodes());
    const runId = await k.steps.start("graph:plain", {}, SCOPE);
    await k.steps.execute(runId);
    await assert.rejects(() => k.steps.resume(runId, "approval:a", {}), /NOT_PAUSED|not paused/);
    await close();
  });
});
