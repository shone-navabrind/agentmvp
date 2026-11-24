import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import type { Db, Queryable } from "./types.ts";

/**
 * PGlite driver: a real Postgres, in-process. Used for tests and single-binary dev.
 * A `pg` Pool driver is the same ~20 lines; nothing above this file knows which is in use.
 */
export function pgliteDb(pg: PGlite): Db {
  const wrap = (q: PGlite | { query: PGlite["query"] }): Queryable => ({
    async query(sql, params) {
      const res = await q.query(sql, params as never[]);
      return { rows: res.rows as never[] };
    },
  });

  return {
    query: wrap(pg).query,
    async tx(fn) {
      return (await pg.transaction(async (t) => fn(wrap(t)))) as never;
    },
  };
}

export async function openMemoryDb(): Promise<{ db: Db; close: () => Promise<void> }> {
  const pg = await PGlite.create();
  return { db: pgliteDb(pg), close: () => pg.close() };
}

/** Same engine, persisted to a directory, so the event log survives a restart. */
export async function openFileDb(dataDir: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const pg = await PGlite.create({ dataDir });
  return { db: pgliteDb(pg), close: () => pg.close() };
}

/**
 * A networked Postgres through a `pg` pool. int8 comes back as a number, as it does from
 * PGlite, so nothing above this file can tell the two apart.
 */
export async function openPostgresDb(connectionString: string): Promise<{ db: Db; close: () => Promise<void> }> {
  const pool = new pg.Pool({
    connectionString,
    types: { getTypeParser: ((oid: number, fmt?: "text" | "binary") => (oid === 20 ? Number : pg.types.getTypeParser(oid, fmt))) as never },
  });
  await pool.query("select 1"); // fail at boot, not on the first request
  const wrap = (c: { query: pg.Pool["query"] }): Queryable => ({
    async query(sql, params) {
      const res = await c.query(sql, params as unknown[]);
      return { rows: res.rows as never[] };
    },
  });
  return {
    db: {
      query: wrap(pool).query,
      async tx(fn) {
        const client = await pool.connect();
        try {
          await client.query("begin");
          const out = await fn(wrap(client));
          await client.query("commit");
          return out;
        } catch (err) {
          await client.query("rollback").catch(() => {});
          throw err;
        } finally {
          client.release();
        }
      },
    },
    close: () => pool.end(),
  };
}
