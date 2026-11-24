import type { Db, Event, Queryable } from "./types.ts";
import type { EventLog } from "./log.ts";

/**
 * A projection is a derived read model. It owns its own tables and never writes to core
 * tables. Because the log is the source of truth, any projection can be dropped and
 * rebuilt -- that property is what makes the board, chat history and audit views cheap.
 */
export type Projection = {
  name: string;
  version: number;
  /** Only these event types are delivered. Omit for all. */
  types?: string[];
  /** Create tables / clear state. Called on first run and on every rebuild. */
  reset(tx: Queryable): Promise<void>;
  apply(tx: Queryable, event: Event): Promise<void>;
  /** Deterministic dump used to verify that a rebuild reproduces the same state. */
  snapshot?(q: Queryable): Promise<unknown>;
};

export class ProjectionRunner {
  #db: Db;
  #log: EventLog;

  constructor(db: Db, log: EventLog) {
    this.#db = db;
    this.#log = log;
  }

  async #checkpoint(p: Projection): Promise<{ version: number; cursor: string | null } | null> {
    const r = await this.#db.query<{ version: number; last_event_id: string | null }>(
      `select version, last_event_id from projection_checkpoints where name = $1`,
      [p.name],
    );
    const row = r.rows[0];
    return row ? { version: row.version, cursor: row.last_event_id } : null;
  }

  /**
   * Catch up to the head of the log. A version bump on the projection triggers an
   * automatic rebuild, so changing a read model is a code change, not a migration.
   */
  async run(p: Projection, opts: { batch?: number } = {}): Promise<{ applied: number; rebuilt: boolean }> {
    let cp = await this.#checkpoint(p);
    let rebuilt = false;

    if (!cp || cp.version !== p.version) {
      await this.#db.tx(async (tx) => {
        await p.reset(tx);
        await tx.query(
          `insert into projection_checkpoints (name, version, last_event_id) values ($1,$2,null)
           on conflict (name) do update set version = $2, last_event_id = null, updated_at = now()`,
          [p.name, p.version],
        );
      });
      rebuilt = cp !== null;
      cp = { version: p.version, cursor: null };
    }

    const batch = opts.batch ?? 500;
    let applied = 0;
    let cursor = cp.cursor;

    for (;;) {
      const events = await this.#log.readAll({ afterId: cursor, limit: batch, types: p.types });
      if (events.length === 0) break;
      // One transaction per batch: the checkpoint advances with the writes it describes,
      // so a crash mid-batch replays the batch rather than skipping it.
      await this.#db.tx(async (tx) => {
        for (const ev of events) await p.apply(tx, ev);
        await tx.query(
          `update projection_checkpoints set last_event_id = $2, updated_at = now() where name = $1`,
          [p.name, events[events.length - 1].cursor],
        );
      });
      applied += events.length;
      cursor = events[events.length - 1].cursor;
      if (events.length < batch) break;
    }
    return { applied, rebuilt };
  }

  async rebuild(p: Projection): Promise<{ applied: number }> {
    await this.#db.query(`delete from projection_checkpoints where name = $1`, [p.name]);
    const { applied } = await this.run(p);
    return { applied };
  }

  async snapshot(p: Projection): Promise<unknown> {
    if (!p.snapshot) throw new Error(`Projection "${p.name}" has no snapshot()`);
    return p.snapshot(this.#db);
  }
}
