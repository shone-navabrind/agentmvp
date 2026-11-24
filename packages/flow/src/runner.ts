import type { FlowDefinition, StepCtx } from "@harness/kernel";
import type { Condition, EgressPolicy, Graph, NodeCtx } from "./types.ts";
import { GuardTripped, StepInputInvalid, StepOutputInvalid } from "./types.ts";
import type { NodeRegistry } from "./registry.ts";
import { evaluate, resolve, resolveInput, type RunState } from "./refs.ts";

export type GraphRunResult = {
  output: unknown;
  steps: number;
  visited: string[];
};

/** What a failed run left behind after unwinding. */
export type Unwound = { node: string; compensated: boolean; reason?: string };

/**
 * Compile a graph into a FlowDefinition the kernel's step runtime can execute.
 * Every node execution goes through ctx.step(), so a graph run inherits crash recovery,
 * memoisation and the ambiguity guard for free.
 */
export function compileGraph(
  g: Graph,
  reg: NodeRegistry,
  opts: { egress?: EgressPolicy } = {},
): FlowDefinition<unknown, GraphRunResult> {
  reg.assertValid(g);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  type Out = { to: string; when?: Condition };
  const outgoing = new Map<string, Out[]>();
  for (const e of g.edges) {
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), { to: e.to, when: e.when }]);
  }

  return {
    kind: `graph:${g.name}`,
    // A graph run resumes rather than retries, and resumption is driven by the
    // worker reclaiming an expired lease. One attempt per execute() keeps a failure
    // terminal so the unwind actually runs.
    maxAttempts: 1,
    async run(ctx: StepCtx, input: unknown): Promise<GraphRunResult> {
      const st: RunState = { input, nodes: {}, state: {}, iteration: {} };
      const visited: string[] = [];
      // Enough to undo each completed node, in the order they completed.
      const completed: Array<{ node: string; input: unknown; output: unknown; iteration: number }> = [];
      const startedAt = Date.now();
      const guards = g.guards ?? {};
      let steps = 0;
      let stallCount = 0;
      let lastWatch = "";
      let current: string | undefined = g.entry;

      const unwind = async (cause: unknown): Promise<void> => {
        const report: Unwound[] = [];
        // Reverse order: the most recent allocation is released first.
        for (const done of [...completed].reverse()) {
          const type = reg.get(byId.get(done.node)!.type)!;
          if (!type.compensate) {
            report.push({ node: done.node, compensated: false, reason: "no compensator" });
            continue;
          }
          const nodeCtx: NodeCtx = {
            step: ctx.step, emit: ctx.emit, budget: ctx.budget, signal: ctx.signal,
            egress: opts.egress, runId: ctx.runId, nodeId: done.node, iteration: done.iteration,
          };
          try {
            // Memoised like any other step, so unwinding is itself resumable and a
            // compensator never runs twice.
            await ctx.step(`compensate:${done.node}#${done.iteration}`, () =>
              type.compensate!(nodeCtx, byId.get(done.node)!.config as never, done.input as never, done.output as never),
            );
            report.push({ node: done.node, compensated: true });
          } catch (err) {
            // A failed compensator must not hide the original failure, and must not
            // stop the rest of the unwind.
            report.push({ node: done.node, compensated: false, reason: String(err) });
          }
        }
        try {
          await ctx.emit("flow.unwound", {
            cause: cause instanceof Error ? cause.message : String(cause),
            unwound: report,
          });
        } catch {
          // Nothing inside an unwind may change the run's fate. An unregistered event
          // type or a write failure here would otherwise replace the original error
          // with a retryable one and turn a failed run into a queued one.
        }
      };

      try {
      while (current) {
        const node = byId.get(current)!;
        const type = reg.get(node.type)!;
        const iteration = st.iteration[current] ?? 0;

        // ---- guards, checked before any work is done ----
        if (guards.maxSteps !== undefined && steps >= guards.maxSteps) {
          throw new GuardTripped("maxSteps", { maxSteps: guards.maxSteps, steps, at: current });
        }
        if (guards.maxWallClockMs !== undefined && Date.now() - startedAt >= guards.maxWallClockMs) {
          throw new GuardTripped("maxWallClockMs", {
            maxWallClockMs: guards.maxWallClockMs,
            elapsedMs: Date.now() - startedAt,
            at: current,
          });
        }
        if (guards.maxCostUsd !== undefined && ctx.budget.spentUsd() >= guards.maxCostUsd) {
          throw new GuardTripped("maxCostUsd", {
            maxCostUsd: guards.maxCostUsd,
            spentUsd: ctx.budget.spentUsd(),
            at: current,
          });
        }
        if (node.maxIterations !== undefined && iteration >= node.maxIterations) {
          throw new GuardTripped("maxIterations", {
            node: current,
            maxIterations: node.maxIterations,
          });
        }
        if (guards.stallAfter) {
          const watch = JSON.stringify(guards.stallAfter.watch.map((w) => resolve(w, st)));
          stallCount = watch === lastWatch ? stallCount + 1 : 0;
          lastWatch = watch;
          if (stallCount >= guards.stallAfter.iterations) {
            throw new GuardTripped("stalled", {
              iterations: stallCount,
              watch: guards.stallAfter.watch,
              at: current,
            });
          }
        }

        // ---- typed input boundary: this is "proper parsing at each step" ----
        const raw = resolveInput(node.input, st);
        const parsedIn = type.inputSchema.safeParse(raw);
        if (!parsedIn.success) {
          throw new StepInputInvalid(node.id, node.type, parsedIn.error.issues, raw);
        }
        const config = type.configSchema.parse(node.config ?? {});

        const nodeCtx: NodeCtx = {
          step: ctx.step,
          egress: opts.egress,
          emit: ctx.emit,
          budget: ctx.budget,
          signal: ctx.signal,
          runId: ctx.runId,
          nodeId: node.id,
          iteration,
        };

        const out = await ctx.step(
          `${node.id}#${iteration}`,
          () => type.execute(nodeCtx, config as never, parsedIn.data as never),
          { idempotent: type.idempotent !== false },
        );

        const parsedOut = type.outputSchema.safeParse(out);
        if (!parsedOut.success) {
          throw new StepOutputInvalid(node.id, node.type, parsedOut.error.issues);
        }

        st.nodes[current] = parsedOut.data;
        st.iteration[current] = iteration + 1;
        visited.push(current);
        completed.push({ node: current, input: parsedIn.data, output: parsedOut.data, iteration });
        steps++;

        const edges: Out[] = outgoing.get(current) ?? [];
        const next = edges.find((e: Out) => !e.when || evaluate(e.when, st));
        current = next?.to;
      }

      return { output: g.output ? resolveInput(g.output, st) : st.nodes, steps, visited };
      } catch (err) {
        // A suspension is not a failure: the run is waiting on a person and its
        // completed work must survive.
        // Unwind only when nothing will try again. A retryable failure keeps its
        // allocations, because the next attempt resumes from the memoised steps that
        // produced them -- releasing a sandbox between attempts would strand the run.
        const suspended = (err as { code?: string }).code === "SUSPEND_RUN";
        if (!suspended && !ctx.willRetry(err)) {
          try {
            await unwind(err);
          } catch {
            // The original failure is what the caller must see.
          }
        }
        throw err;
      }
    },
  };
}
