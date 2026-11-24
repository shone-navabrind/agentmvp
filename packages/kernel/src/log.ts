import type { Db, Event, EventInput, Queryable } from "./types.ts";
import { DuplicateEvent } from "./types.ts";
import type { SchemaRegistry } from "./registry.ts";
import { ulid } from "./ulid.ts";

export type Subscription = {
  destination: string;
  /** Glob over event type, e.g. "task.*" or "*". */
  match: string;
};

function globToRegExp(glob: string): RegExp {
  return new RegExp("^" + glob.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
}

type Row = {
  id: string; ordinal: string | number | bigint; stream: string; seq: string | number | bigint; type: string;
  tenant_id: string; workspace_id: string; project_id: string | null;
  actor: unknown; at: Date | string; payload: unknown;
  idem_key: string | null; causation_id: string | null; correlation_id: string | null;
};

export class EventLog {
  #db: Db;
  #registry: SchemaRegistry;
  #subs: Array<Subscription & { re: RegExp }> = [];

  constructor(db: Db, registry: SchemaRegistry) {
    this.#db = db;
    this.#registry = registry;
  }

  /** Register an outbox destination. Matching events are enqueued in the same transaction. */
  subscribe(sub: Subscription): this {
    this.#subs.push({ ...sub, re: globToRegExp(sub.match) });
    return this;
  }

  #hydrate(row: Row): Event {
    const { type, payload } = this.#registry.upcast(row.type, row.payload);
    return {
      id: row.id,
      stream: row.stream,
      seq: String(row.seq),
      cursor: String(row.ordinal),
      type,
      tenantId: row.tenant_id,
      workspaceId: row.workspace_id,
      projectId: row.project_id,
      actor: row.actor as Event["actor"],
      at: new Date(row.at).toISOString(),
      payload,
      idemKey: row.idem_key,
      causationId: row.causation_id,
      correlationId: row.correlation_id,
    };
  }

  /**
   * Append one event. Pass `tx` to make it atomic with your own writes -- that atomicity
   * is the whole reason the log is trustworthy as an audit trail.
   */
  async append<P>(input: EventInput<P>, tx?: Queryable): Promise<Event<P>> {
    const run = async (q: Queryable): Promise<Event<P>> => {
      const payload = this.#registry.validateForWrite(input.type, input.payload);

      if (input.idemKey) {
        const prior = await q.query<Row>(
          `select * from events where stream = $1 and idem_key = $2`,
          [input.stream, input.idemKey],
        );
        if (prior.rows[0]) return this.#hydrate(prior.rows[0]) as Event<P>;
      }

      // Gapless per-stream sequence. The upsert takes a row lock, serialising
      // concurrent appends to the same stream without a table-wide bottleneck.
      const seqRes = await q.query<{ seq: string }>(
        `insert into streams (stream, next_seq) values ($1, 2)
         on conflict (stream) do update set next_seq = streams.next_seq + 1
         returning (streams.next_seq - 1)::text as seq`,
        [input.stream],
      );
      const seq = seqRes.rows[0].seq;

      // Global ordinal, same serialization trick as the per-stream counter. The row
      // lock is held until commit, so ordinals come out in commit order.
      const ordRes = await q.query<{ ord: string }>(
        `insert into streams (stream, next_seq) values ('__global__', 2)
         on conflict (stream) do update set next_seq = streams.next_seq + 1
         returning (streams.next_seq - 1)::text as ord`,
      );
      const ordinal = ordRes.rows[0].ord;

      const id = ulid();
      const at = input.at ?? new Date().toISOString();
      let inserted;
      try {
        inserted = await q.query<Row>(
          `insert into events (id, ordinal, stream, seq, type, tenant_id, workspace_id, project_id,
                               actor, at, payload, idem_key, causation_id, correlation_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning *`,
          [
            id, ordinal, input.stream, seq, input.type, input.tenantId, input.workspaceId,
            input.projectId ?? null, JSON.stringify(input.actor), at, JSON.stringify(payload),
            input.idemKey ?? null, input.causationId ?? null, input.correlationId ?? null,
          ],
        );
      } catch (err) {
        if (input.idemKey && String(err).includes("events_idem")) {
          throw new DuplicateEvent(input.stream, input.idemKey);
        }
        throw err;
      }

      for (const sub of this.#subs) {
        if (sub.re.test(input.type)) {
          await q.query(`insert into outbox (event_id, destination) values ($1, $2)`, [
            id, sub.destination,
          ]);
        }
      }
      return this.#hydrate(inserted.rows[0]) as Event<P>;
    };

    return tx ? run(tx) : this.#db.tx(run);
  }

  async readStream(stream: string, opts: { fromSeq?: number; limit?: number } = {}): Promise<Event[]> {
    const res = await this.#db.query<Row>(
      `select * from events where stream = $1 and seq >= $2 order by seq asc limit $3`,
      [stream, opts.fromSeq ?? 1, opts.limit ?? 1000],
    );
    return res.rows.map((r) => this.#hydrate(r));
  }

  /**
   * Global cursor read, ordered by commit-order ordinal. Callers pass the `cursor`
   * from the last event they processed.
   */
  async readAll(opts: { afterId?: string | null; limit?: number; types?: string[] } = {}): Promise<Event[]> {
    const params: unknown[] = [opts.afterId ?? "0", opts.limit ?? 1000];
    let typeClause = "";
    if (opts.types?.length) {
      params.push(opts.types);
      typeClause = ` and type = any($3)`;
    }
    const res = await this.#db.query<Row>(
      `select * from events where ordinal > $1::bigint${typeClause} order by ordinal asc limit $2`,
      params,
    );
    return res.rows.map((r) => this.#hydrate(r));
  }

  async byId(id: string): Promise<Event | null> {
    const res = await this.#db.query<Row>(`select * from events where id = $1`, [id]);
    return res.rows[0] ? this.#hydrate(res.rows[0]) : null;
  }

  async count(): Promise<number> {
    const r = await this.#db.query<{ n: string }>(`select count(*)::text as n from events`);
    return Number(r.rows[0].n);
  }
}
