import type { Event, Projection, Queryable } from "@harness/kernel";
import { BOARD_EVENT_TYPES, type TaskState } from "./events.ts";

export type TaskRow = {
  task_id: string;
  project_id: string;
  title: string;
  state: TaskState;
  assignee: string | null;
  labels: string[];
  parent_id: string | null;
  run_id: string | null;
  session_ids: string[];
  pr_urls: string[];
  reason: string | null;
  question: unknown;
  comments: number;
  moves: number;
  created_at: string;
  updated_at: string;
};

/**
 * The board is a projection, not a datastore. Drop it and rebuild from the log.
 * That is what lets flow runs, approvals and agent sessions appear on it without
 * any of them writing to a board table.
 */
export const boardProjection: Projection = {
  name: "board",
  version: 1,
  types: BOARD_EVENT_TYPES,

  async reset(tx: Queryable) {
    await tx.query(`drop table if exists board_tasks`);
    await tx.query(`create table board_tasks (
      task_id     text primary key,
      project_id  text not null,
      title       text not null,
      state       text not null,
      assignee    text,
      labels      jsonb not null default '[]',
      parent_id   text,
      run_id      text,
      session_ids jsonb not null default '[]',
      pr_urls     jsonb not null default '[]',
      reason      text,
      question    jsonb,
      comments    int not null default 0,
      moves       int not null default 0,
      created_at  timestamptz not null,
      updated_at  timestamptz not null
    )`);
    await tx.query(`create index board_tasks_project on board_tasks (project_id, state)`);
  },

  async apply(tx: Queryable, ev: Event) {
    const p = ev.payload as Record<string, never>;
    const id = p.taskId as string;

    switch (ev.type) {
      case "task.created":
        await tx.query(
          `insert into board_tasks
             (task_id, project_id, title, state, labels, parent_id, created_at, updated_at)
           values ($1,$2,$3,$4,$5,$6,$7,$7)
           on conflict (task_id) do nothing`,
          [id, ev.projectId, p.title, p.state, JSON.stringify(p.labels ?? []), p.parentId ?? null, ev.at],
        );
        break;

      case "task.raised":
        await tx.query(
          `insert into board_tasks
             (task_id, project_id, title, state, reason, run_id, question, created_at, updated_at)
           values ($1,$2,$3,'blocked',$4,$5,$6,$7,$7)
           on conflict (task_id) do update set
             state='blocked', reason=$4, run_id=$5, question=$6, updated_at=$7`,
          [
            id, ev.projectId, p.title, p.reason, p.runId ?? null,
            JSON.stringify(p.question ?? null), ev.at,
          ],
        );
        break;

      case "task.moved":
        await tx.query(
          `update board_tasks set state=$2, moves=moves+1, updated_at=$3,
             reason = case when $2 = 'blocked' then reason else null end
           where task_id=$1`,
          [id, p.to, ev.at],
        );
        break;

      case "task.assigned":
        await tx.query(`update board_tasks set assignee=$2, updated_at=$3 where task_id=$1`, [
          id,
          p.assigneeKind === "none" ? null : `${p.assigneeKind}:${p.assigneeId}`,
          ev.at,
        ]);
        break;

      case "task.linked": {
        const col =
          p.link === "session" ? "session_ids" : p.link === "pr" ? "pr_urls" : null;
        if (col) {
          await tx.query(
            `update board_tasks
             set ${col} = (
               select to_jsonb(array(select distinct x from jsonb_array_elements_text(${col} || to_jsonb($2::text)) as t(x) order by x))
             ), updated_at=$3
             where task_id=$1`,
            [id, p.ref, ev.at],
          );
        } else {
          await tx.query(`update board_tasks set run_id=$2, updated_at=$3 where task_id=$1`, [
            id, p.ref, ev.at,
          ]);
        }
        break;
      }

      case "task.commented":
        await tx.query(
          `update board_tasks set comments=comments+1, updated_at=$2 where task_id=$1`,
          [id, ev.at],
        );
        break;
    }
  },

  async snapshot(q: Queryable) {
    const r = await q.query(
      `select task_id, project_id, title, state, assignee, labels, run_id, session_ids,
              pr_urls, reason, comments, moves
       from board_tasks order by task_id`,
    );
    return r.rows;
  },
};
