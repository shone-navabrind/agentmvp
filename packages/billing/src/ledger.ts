import type { Db, Queryable } from "@harness/kernel";
import { KernelError } from "@harness/kernel";

export const LEDGER_DDL = `
create table if not exists wallets (
  workspace_id    text primary key,
  balance_micros  bigint not null default 0,
  updated_at      timestamptz not null default now()
);

create table if not exists ledger_entries (
  id            bigserial primary key,
  workspace_id  text not null,
  project_id    text,
  kind          text not null,              -- grant | debit | refund | fee
  amount_micros bigint not null,            -- positive credits, negative debits
  billable      boolean not null default true,
  ref           text,
  idem_key      text not null,
  at            timestamptz not null default now()
);
create unique index if not exists ledger_idem on ledger_entries (workspace_id, idem_key);
create index if not exists ledger_ws on ledger_entries (workspace_id, at);
`;

export class InsufficientCredit extends KernelError {
  constructor(workspaceId: string, balanceMicros: number, wantMicros: number) {
    super(
      "INSUFFICIENT_CREDIT",
      `Workspace "${workspaceId}" has $${(balanceMicros / 1e6).toFixed(4)}, needs $${(wantMicros / 1e6).toFixed(4)}`,
      { workspaceId, balanceMicros, wantMicros },
      false,
    );
  }
}

export type LedgerEntry = {
  id: number;
  workspace_id: string;
  project_id: string | null;
  kind: "grant" | "debit" | "refund" | "fee";
  amount_micros: string;
  billable: boolean;
  ref: string | null;
  idem_key: string;
  at: string;
};

export function usdToMicros(usd: number): number {
  return Math.round(usd * 1e6);
}
export function microsToUsd(micros: number): number {
  return micros / 1e6;
}

/**
 * Append-only ledger in USD micro-units. Integers, so no float drift; idempotency keys,
 * so a retried spend-sync cannot double-charge; balance is a materialised sum kept in the
 * same transaction as the entry that moved it.
 */
export class Ledger {
  #db: Db;
  constructor(db: Db) {
    this.#db = db;
  }

  async migrate(): Promise<void> {
    for (const stmt of LEDGER_DDL.split(";\n").map((s) => s.trim()).filter(Boolean)) {
      await this.#db.query(stmt);
    }
  }

  async balance(workspaceId: string): Promise<number> {
    const r = await this.#db.query<{ balance_micros: string }>(
      `select balance_micros from wallets where workspace_id = $1`,
      [workspaceId],
    );
    return Number(r.rows[0]?.balance_micros ?? 0);
  }

  async #post(
    tx: Queryable,
    e: {
      workspaceId: string;
      projectId?: string | null;
      kind: LedgerEntry["kind"];
      amountMicros: number;
      billable?: boolean;
      ref?: string;
      idemKey: string;
    },
  ): Promise<{ applied: boolean; balanceMicros: number }> {
    const dup = await tx.query<{ id: number }>(
      `select id from ledger_entries where workspace_id = $1 and idem_key = $2`,
      [e.workspaceId, e.idemKey],
    );
    if (dup.rows[0]) {
      const b = await tx.query<{ balance_micros: string }>(
        `select balance_micros from wallets where workspace_id = $1`,
        [e.workspaceId],
      );
      return { applied: false, balanceMicros: Number(b.rows[0]?.balance_micros ?? 0) };
    }

    await tx.query(
      `insert into ledger_entries
         (workspace_id, project_id, kind, amount_micros, billable, ref, idem_key)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [
        e.workspaceId, e.projectId ?? null, e.kind, e.amountMicros,
        e.billable ?? true, e.ref ?? null, e.idemKey,
      ],
    );

    // BYOK spend is recorded for visibility but never moves the balance.
    const delta = e.billable === false ? 0 : e.amountMicros;
    const r = await tx.query<{ balance_micros: string }>(
      `insert into wallets (workspace_id, balance_micros) values ($1,$2)
       on conflict (workspace_id)
         do update set balance_micros = wallets.balance_micros + $2, updated_at = now()
       returning balance_micros`,
      [e.workspaceId, delta],
    );
    return { applied: true, balanceMicros: Number(r.rows[0].balance_micros) };
  }

  async grant(
    workspaceId: string,
    usd: number,
    idemKey: string,
    ref?: string,
  ): Promise<{ applied: boolean; balanceMicros: number }> {
    return this.#db.tx((tx) =>
      this.#post(tx, {
        workspaceId,
        kind: "grant",
        amountMicros: usdToMicros(usd),
        idemKey,
        ref,
      }),
    );
  }

  /**
   * Record spend. `billable: false` is BYOK: visible in the ledger, never charged.
   * Debits may take the balance negative -- the gateway caps spend, but an in-flight
   * request can land after the cap, and pretending otherwise would lose the record.
   */
  async debit(
    e: {
      workspaceId: string;
      projectId?: string;
      usd: number;
      idemKey: string;
      ref?: string;
      billable?: boolean;
    },
  ): Promise<{ applied: boolean; balanceMicros: number }> {
    return this.#db.tx((tx) =>
      this.#post(tx, {
        workspaceId: e.workspaceId,
        projectId: e.projectId,
        kind: "debit",
        amountMicros: -usdToMicros(e.usd),
        billable: e.billable,
        ref: e.ref,
        idemKey: e.idemKey,
      }),
    );
  }

  async entries(workspaceId: string): Promise<LedgerEntry[]> {
    const r = await this.#db.query<LedgerEntry>(
      `select * from ledger_entries where workspace_id = $1 order by id`,
      [workspaceId],
    );
    return r.rows;
  }

  /** The ledger must always equal the sum of its billable entries. */
  async reconcile(workspaceId: string): Promise<{ balanceMicros: number; sumMicros: number; drift: number }> {
    const b = await this.balance(workspaceId);
    const r = await this.#db.query<{ sum: string | null }>(
      `select sum(amount_micros)::text as sum from ledger_entries
       where workspace_id = $1 and billable = true`,
      [workspaceId],
    );
    const sum = Number(r.rows[0].sum ?? 0);
    return { balanceMicros: b, sumMicros: sum, drift: b - sum };
  }

  async spendByProject(workspaceId: string): Promise<Record<string, number>> {
    const r = await this.#db.query<{ project_id: string | null; spent: string }>(
      `select project_id, (-sum(amount_micros))::text as spent
       from ledger_entries
       where workspace_id = $1 and kind = 'debit'
       group by project_id`,
      [workspaceId],
    );
    const out: Record<string, number> = {};
    for (const row of r.rows) out[row.project_id ?? "(unassigned)"] = Number(row.spent);
    return out;
  }
}
