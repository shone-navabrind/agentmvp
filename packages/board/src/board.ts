import type { Actor, Db, EventLog, Scope, StepRuntime } from "@harness/kernel";
import { ulid } from "@harness/kernel";
import type { TaskRow } from "./projection.ts";
import type { TaskState } from "./events.ts";

export type Automation = {
  id: string;
  /** Fire when a task enters this state. */
  onEnter: TaskState;
  /** Optional label filter. */
  withLabel?: string;
  /** Flow kind to start, receiving { taskId, title }. */
  startFlow: string;
};

/**
 * The board's write side. Every mutation is an event; the read model follows.
 * Automations turn board transitions into flow runs, which is how "move a card,
 * an agent picks it up" works without any special-case code.
 */
export class Board {
  #db: Db;
  #log: EventLog;
  #steps: StepRuntime;
  #automations: Automation[] = [];

  constructor(opts: { db: Db; log: EventLog; steps: StepRuntime }) {
    this.#db = opts.db;
    this.#log = opts.log;
    this.#steps = opts.steps;
  }

  automate(a: Automation): this {
    this.#automations.push(a);
    return this;
  }

  async createTask(
    scope: Scope,
    actor: Actor,
    input: { title: string; state?: TaskState; labels?: string[]; parentId?: string | null },
  ): Promise<string> {
    const taskId = `T-${ulid().slice(-8)}`;
    await this.#log.append({
      ...scope,
      stream: `project:${scope.projectId}`,
      type: "task.created",
      actor,
      payload: {
        taskId,
        title: input.title,
        state: input.state ?? "todo",
        labels: input.labels ?? [],
        parentId: input.parentId ?? null,
      },
    });
    return taskId;
  }

  async move(scope: Scope, actor: Actor, taskId: string, to: TaskState): Promise<void> {
    const cur = await this.task(taskId);
    await this.#log.append({
      ...scope,
      stream: `project:${scope.projectId}`,
      type: "task.moved",
      actor,
      payload: { taskId, from: (cur?.state as TaskState) ?? null, to },
    });
  }

  async assign(
    scope: Scope,
    actor: Actor,
    taskId: string,
    assignee: { kind: "user" | "agent" | "none"; id: string | null },
  ): Promise<void> {
    await this.#log.append({
      ...scope,
      stream: `project:${scope.projectId}`,
      type: "task.assigned",
      actor,
      payload: { taskId, assigneeKind: assignee.kind, assigneeId: assignee.id },
    });
  }

  async link(
    scope: Scope,
    actor: Actor,
    taskId: string,
    link: "session" | "flowRun" | "pr",
    ref: string,
  ): Promise<void> {
    await this.#log.append({
      ...scope,
      stream: `project:${scope.projectId}`,
      type: "task.linked",
      actor,
      payload: { taskId, link, ref },
    });
  }

  async comment(scope: Scope, actor: Actor, taskId: string, body: string): Promise<void> {
    await this.#log.append({
      ...scope,
      stream: `project:${scope.projectId}`,
      type: "task.commented",
      actor,
      payload: { taskId, body },
    });
  }

  /**
   * Turn every paused or failed flow run into a board card. This is why the board is
   * worth owning rather than integrating: it is the human-in-the-loop inbox.
   */
  async syncFromRuns(scope: Scope): Promise<{ raised: number }> {
    let raised = 0;
    for (const r of await this.#steps.awaitingDecision()) {
      const taskId = `T-run-${r.id.slice(-8)}`;
      const q = r.question as { text?: string } | undefined;
      await this.#log.append({
        ...scope,
        stream: `project:${scope.projectId}`,
        type: "task.raised",
        actor: { kind: "system", id: "board-sync" },
        idemKey: `raised:${r.id}`,
        payload: {
          taskId,
          title: q?.text ?? `Decision needed: ${r.kind}`,
          reason: "approval",
          runId: r.id,
          stepKey: null,
          question: r.question,
        },
      });
      raised++;
    }
    return { raised };
  }

  /** Run automations for tasks that just entered a state. Returns the runs started. */
  async runAutomations(scope: Scope): Promise<Array<{ taskId: string; runId: string }>> {
    const started: Array<{ taskId: string; runId: string }> = [];
    for (const a of this.#automations) {
      const rows = await this.#db.query<TaskRow>(
        `select * from board_tasks where project_id = $1 and state = $2 and run_id is null`,
        [scope.projectId, a.onEnter],
      );
      for (const row of rows.rows) {
        if (a.withLabel && !(row.labels ?? []).includes(a.withLabel)) continue;
        const runId = await this.#steps.start(
          a.startFlow,
          { taskId: row.task_id, title: row.title },
          scope,
        );
        await this.link(scope, { kind: "system", id: `automation:${a.id}` }, row.task_id, "flowRun", runId);
        started.push({ taskId: row.task_id, runId });
      }
    }
    return started;
  }

  async task(taskId: string): Promise<TaskRow | null> {
    const r = await this.#db.query<TaskRow>(`select * from board_tasks where task_id = $1`, [taskId]);
    return r.rows[0] ?? null;
  }

  async columns(projectId: string): Promise<Record<string, TaskRow[]>> {
    const r = await this.#db.query<TaskRow>(
      `select * from board_tasks where project_id = $1 order by updated_at desc`,
      [projectId],
    );
    const out: Record<string, TaskRow[]> = {};
    for (const row of r.rows) (out[row.state] ??= []).push(row);
    return out;
  }

  /** Cards waiting on a person, newest first. */
  async inbox(projectId: string): Promise<TaskRow[]> {
    const r = await this.#db.query<TaskRow>(
      `select * from board_tasks
       where project_id = $1 and state = 'blocked' and reason is not null
       order by updated_at desc`,
      [projectId],
    );
    return r.rows;
  }
}
