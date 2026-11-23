import { PGlite } from "@electric-sql/pglite";
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
