import { z } from "zod";
import type { Event, Queryable } from "./types.ts";
import type { SchemaRegistry } from "./registry.ts";
import type { Projection } from "./projections.ts";

export const SCOPE = { tenantId: "t1", workspaceId: "ws1", projectId: "p1" };
export const USER = { kind: "user" as const, id: "u1" };

/**
 * A realistic slice of the board's event vocabulary, including one superseded version,
 * so upcasting is exercised the way it will be in production.
 */
export function defineBoardEvents(r: SchemaRegistry): SchemaRegistry {
  r.define({
    type: "task.created",
    schema: z.object({ taskId: z.string(), title: z.string(), state: z.string() }),
  });
  r.define({
    type: "task.moved.v1",
    schema: z.object({ taskId: z.string(), to: z.string() }),
    supersededBy: "task.moved.v2",
    // v2 added `from`; history cannot know it, so it reads as null rather than a guess.
    upcast: (p: never) => ({ ...(p as object), from: null }),
  });
  r.define({
    type: "task.moved.v2",
    schema: z.object({ taskId: z.string(), from: z.string().nullable(), to: z.string() }),
  });
  r.define({
    type: "task.assigned",
    schema: z.object({
      taskId: z.string(),
      assigneeKind: z.enum(["user", "agent"]),
      assigneeId: z.string(),
    }),
  });
  return r;
}

/** The board read model: derived entirely from the log, droppable and rebuildable. */
export const boardProjection: Projection = {
  name: "board",
  version: 1,
  types: ["task.created", "task.moved.v1", "task.moved.v2", "task.assigned"],

  async reset(tx: Queryable) {
    await tx.query(`drop table if exists board_tasks`);
    await tx.query(`create table board_tasks (
      task_id text primary key,
      title text not null,
      state text not null,
      assignee text,
      moves int not null default 0
    )`);
  },

  async apply(tx: Queryable, ev: Event) {
    const p = ev.payload as Record<string, string | null>;
    if (ev.type === "task.created") {
      await tx.query(
        `insert into board_tasks (task_id, title, state) values ($1,$2,$3)
         on conflict (task_id) do nothing`,
        [p.taskId, p.title, p.state],
      );
    } else if (ev.type === "task.moved.v2") {
      await tx.query(
        `update board_tasks set state = $2, moves = moves + 1 where task_id = $1`,
        [p.taskId, p.to],
      );
    } else if (ev.type === "task.assigned") {
      await tx.query(`update board_tasks set assignee = $2 where task_id = $1`, [
        p.taskId,
        `${p.assigneeKind}:${p.assigneeId}`,
      ]);
    }
  },

  async snapshot(q: Queryable) {
    const r = await q.query(
      `select task_id, title, state, assignee, moves from board_tasks order by task_id`,
    );
    return r.rows;
  },
};
