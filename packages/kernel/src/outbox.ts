import type { Db, Event } from "./types.ts";
import type { EventLog } from "./log.ts";

export type Delivery = {
  id: number;
  destination: string;
  event: Event;
  attempts: number;
};

export type DeliveryResult = { ok: true } | { ok: false; error: string; retry: boolean };

/**
 * Transactional outbox. Rows are written in the same transaction as the event they
 * describe, so "the event happened but nobody was told" cannot occur. Delivery is
 * at-least-once with backoff, a dead-letter state, and replay from the log.
 */
export class Outbox {
  #db: Db;
  #log: EventLog;
  #maxAttempts: number;
  #backoffMs: (attempt: number) => number;

  constructor(
    db: Db,
    log: EventLog,
    opts: { maxAttempts?: number; backoffMs?: (attempt: number) => number } = {},
  ) {
    this.#db = db;
    this.#log = log;
    this.#maxAttempts = opts.maxAttempts ?? 5;
    this.#backoffMs = opts.backoffMs ?? ((a) => Math.min(60_000, 2 ** a * 250));
  }

  async pending(now: Date = new Date()): Promise<number> {
    const r = await this.#db.query<{ n: string }>(
      `select count(*)::text as n from outbox where state = 'pending' and next_attempt_at <= $1`,
      [now.toISOString()],
    );
    return Number(r.rows[0].n);
  }

  async deadLettered(): Promise<Array<{ id: number; destination: string; last_error: string }>> {
    const r = await this.#db.query<{ id: number; destination: string; last_error: string }>(
      `select id, destination, last_error from outbox where state = 'dead' order by id`,
    );
    return r.rows;
  }

  /** Drain one batch. Returns counts so a worker loop can decide whether to sleep. */
  async drain(
    deliver: (d: Delivery) => Promise<DeliveryResult>,
    opts: { batch?: number; now?: Date } = {},
  ): Promise<{ delivered: number; retried: number; dead: number }> {
    const now = opts.now ?? new Date();
    const rows = await this.#db.query<{
      id: number;
      destination: string;
      attempts: number;
      event_id: string;
    }>(
      `select id, destination, attempts, event_id from outbox
       where state = 'pending' and next_attempt_at <= $1
       order by id asc limit $2`,
      [now.toISOString(), opts.batch ?? 100],
    );

    let delivered = 0;
    let retried = 0;
    let dead = 0;

    for (const row of rows.rows) {
      const event = (await this.#log.byId(row.event_id))!;
      const attempts = row.attempts + 1;
      let result: DeliveryResult;
      try {
        result = await deliver({ id: row.id, destination: row.destination, event, attempts });
      } catch (err) {
        result = { ok: false, error: String(err), retry: true };
      }

      if (result.ok) {
        await this.#db.query(`update outbox set state='delivered', attempts=$2 where id=$1`, [
          row.id,
          attempts,
        ]);
        delivered++;
      } else if (result.retry && attempts < this.#maxAttempts) {
        await this.#db.query(
          `update outbox set attempts=$2, next_attempt_at=$3, last_error=$4 where id=$1`,
          [row.id, attempts, new Date(now.getTime() + this.#backoffMs(attempts)).toISOString(), result.error],
        );
        retried++;
      } else {
        await this.#db.query(
          `update outbox set state='dead', attempts=$2, last_error=$3 where id=$1`,
          [row.id, attempts, result.error],
        );
        dead++;
      }
    }
    return { delivered, retried, dead };
  }
}
