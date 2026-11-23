import { z } from "zod";
import type { SchemaRegistry } from "@harness/kernel";

export const TASK_STATES = ["todo", "doing", "review", "blocked", "done"] as const;
export type TaskState = (typeof TASK_STATES)[number];

export const taskCreated = z.object({
  taskId: z.string(),
  title: z.string(),
  state: z.enum(TASK_STATES).default("todo"),
  labels: z.array(z.string()).default([]),
  parentId: z.string().nullable().default(null),
});

export const taskMoved = z.object({
  taskId: z.string(),
  from: z.enum(TASK_STATES).nullable(),
  to: z.enum(TASK_STATES),
});

export const taskAssigned = z.object({
  taskId: z.string(),
  assigneeKind: z.enum(["user", "agent", "none"]),
  assigneeId: z.string().nullable(),
});

export const taskLinked = z.object({
  taskId: z.string(),
  link: z.enum(["session", "flowRun", "pr"]),
  ref: z.string(),
});

export const taskCommented = z.object({
  taskId: z.string(),
  body: z.string(),
});

/** Raised automatically when a flow suspends on an approval, or a run fails. */
export const taskRaised = z.object({
  taskId: z.string(),
  title: z.string(),
  reason: z.enum(["approval", "flow-failed", "budget", "step-invalid"]),
  runId: z.string().nullable().default(null),
  stepKey: z.string().nullable().default(null),
  question: z.unknown().optional(),
});

export function defineBoardEvents(r: SchemaRegistry): SchemaRegistry {
  r.define({ type: "task.created", schema: taskCreated });
  r.define({ type: "task.moved", schema: taskMoved });
  r.define({ type: "task.assigned", schema: taskAssigned });
  r.define({ type: "task.linked", schema: taskLinked });
  r.define({ type: "task.commented", schema: taskCommented });
  r.define({ type: "task.raised", schema: taskRaised });
  return r;
}

export const BOARD_EVENT_TYPES = [
  "task.created",
  "task.moved",
  "task.assigned",
  "task.linked",
  "task.commented",
  "task.raised",
];
