import type { ZodType, ZodTypeDef } from "zod";
import type { StepCtx } from "@harness/kernel";
import { KernelError } from "@harness/kernel";
export { SuspendRun } from "@harness/kernel";

/** A reference into run state: "$.input.x", "$.nodes.<id>.<path>", "$.state.<key>", or a literal. */
export type Ref = string | number | boolean | null | { [k: string]: Ref } | Ref[];

export type Condition =
  | { op: "always" }
  | { op: "eq"; left: Ref; right: Ref }
  | { op: "neq"; left: Ref; right: Ref }
  | { op: "gt"; left: Ref; right: Ref }
  | { op: "lt"; left: Ref; right: Ref }
  | { op: "truthy"; value: Ref }
  | { op: "not"; of: Condition }
  | { op: "and"; all: Condition[] }
  | { op: "or"; any: Condition[] };

export type NodeSpec = {
  id: string;
  type: string;
  /** Static configuration, validated against the node type's configSchema at save time. */
  config?: unknown;
  /** Input mapping: object of refs resolved against run state at execution time. */
  input?: Record<string, Ref>;
  /** Per-node guard for nodes reachable in a cycle. */
  maxIterations?: number;
};

export type Edge = { from: string; to: string; when?: Condition };

export type Guards = {
  maxSteps?: number;
  maxCostUsd?: number;
  maxWallClockMs?: number;
  /** Halt if these state paths do not change across N consecutive iterations. */
  stallAfter?: { iterations: number; watch: string[] };
};

export type Graph = {
  name: string;
  entry: string;
  nodes: NodeSpec[];
  edges: Edge[];
  guards?: Guards;
  /** Mapping from run state to the flow's return value. */
  output?: Record<string, Ref>;
};

export type NodeCtx = {
  step: StepCtx["step"];
  emit: StepCtx["emit"];
  budget: StepCtx["budget"];
  signal: AbortSignal;
  runId: string;
  nodeId: string;
  iteration: number;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- the third Zod param is the pre-parse
   input type, which legitimately differs from the output when defaults are used. */
export type NodeType<C = unknown, I = unknown, O = unknown> = {
  type: string;
  configSchema: ZodType<C, ZodTypeDef, any>;
  inputSchema: ZodType<I, ZodTypeDef, any>;
  outputSchema: ZodType<O, ZodTypeDef, any>;
  /** false => an interrupted attempt cannot be blindly retried. */
  idempotent?: boolean;
  /** Nodes that suspend the run (human approval) declare it so validation can reason about it. */
  suspends?: boolean;
  execute(ctx: NodeCtx, config: C, input: I): Promise<O>;
};

export class GraphInvalid extends KernelError {
  constructor(problems: string[]) {
    super("GRAPH_INVALID", `Graph failed validation:\n  - ${problems.join("\n  - ")}`, { problems }, false);
  }
}

export class StepInputInvalid extends KernelError {
  constructor(nodeId: string, nodeType: string, issues: unknown, received: unknown) {
    super(
      "STEP_INPUT_INVALID",
      `Input to node "${nodeId}" (${nodeType}) failed validation`,
      { nodeId, nodeType, issues, received },
      false,
    );
  }
}

export class StepOutputInvalid extends KernelError {
  constructor(nodeId: string, nodeType: string, issues: unknown) {
    super(
      "STEP_OUTPUT_INVALID",
      `Output of node "${nodeId}" (${nodeType}) failed validation`,
      { nodeId, nodeType, issues },
      false,
    );
  }
}

export class GuardTripped extends KernelError {
  constructor(guard: string, detail: Record<string, unknown>) {
    super("GUARD_TRIPPED", `Flow halted: ${guard}`, { guard, ...detail }, false);
  }
}

/** Infers a node's config/input/output types from its schemas, so they can never drift. */
export function defineNode<C extends ZodType, I extends ZodType, O extends ZodType>(d: {
  type: string;
  configSchema: C;
  inputSchema: I;
  outputSchema: O;
  idempotent?: boolean;
  suspends?: boolean;
  execute(
    ctx: NodeCtx,
    config: C["_output"],
    input: I["_output"],
  ): Promise<O["_output"]>;
}): NodeType<C["_output"], I["_output"], O["_output"]> {
  return d as NodeType<C["_output"], I["_output"], O["_output"]>;
}
