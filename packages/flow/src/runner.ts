import type { FlowDefinition, StepCtx } from "@harness/kernel";
import type { Condition, Graph, NodeCtx } from "./types.ts";
import { GuardTripped, StepInputInvalid, StepOutputInvalid } from "./types.ts";
import type { NodeRegistry } from "./registry.ts";
import { evaluate, resolve, resolveInput, type RunState } from "./refs.ts";

export type GraphRunResult = {
  output: unknown;
  steps: number;
  visited: string[];
};

/**
 * Compile a graph into a FlowDefinition the kernel's step runtime can execute.
 * Every node execution goes through ctx.step(), so a graph run inherits crash recovery,
 * memoisation and the ambiguity guard for free.
 */
export function compileGraph(g: Graph, reg: NodeRegistry): FlowDefinition<unknown, GraphRunResult> {
  reg.assertValid(g);
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  type Out = { to: string; when?: Condition };
  const outgoing = new Map<string, Out[]>();
  for (const e of g.edges) {
    outgoing.set(e.from, [...(outgoing.get(e.from) ?? []), { to: e.to, when: e.when }]);
  }

  return {
    kind: `graph:${g.name}`,
    maxAttempts: 25, // graph runs resume; attempts are resumptions, not retries of work
    async run(ctx: StepCtx, input: unknown): Promise<GraphRunResult> {
      const st: RunState = { input, nodes: {}, state: {}, iteration: {} };
      const visited: string[] = [];
      const startedAt = Date.now();
      const guards = g.guards ?? {};
      let steps = 0;
      let stallCount = 0;
      let lastWatch = "";
      let current: string | undefined = g.entry;

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
        steps++;

        const edges: Out[] = outgoing.get(current) ?? [];
        const next = edges.find((e: Out) => !e.when || evaluate(e.when, st));
        current = next?.to;
      }

      return { output: g.output ? resolveInput(g.output, st) : st.nodes, steps, visited };
    },
  };
}
