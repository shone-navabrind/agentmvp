import type { Ledger } from "./ledger.ts";
import { microsToUsd } from "./ledger.ts";

export type GatewayKey = {
  projectId: string;
  workspaceId: string;
  litellmKeyId: string;
  maxBudgetUsd: number;
  models: string[];
};

/** The gateway the budget is pushed to. LiteLLM is the default implementation. */
export interface GatewayAdmin {
  setKeyBudget(keyId: string, maxBudgetUsd: number): Promise<void>;
  revokeKey(keyId: string): Promise<void>;
  /** Spend per key since the last call, in USD. */
  pullSpend(): Promise<Array<{ keyId: string; usd: number; windowId: string }>>;
}

export type Alert = { workspaceId: string; level: 80 | 100; balanceMicros: number; grantedMicros: number };

/**
 * Keeps the gateway's own caps equal to the remaining balance, so the gateway refuses
 * requests at zero rather than the platform discovering the overspend later.
 *
 * This is best-effort, not exact: spend lands after a streaming request completes, and
 * the sync runs on an interval, so worst-case overspend is roughly
 * (concurrent in-flight requests x max cost per request) + one sync interval.
 */
export class BudgetEnforcer {
  #ledger: Ledger;
  #gateway: GatewayAdmin;
  #alerted = new Set<string>();

  constructor(opts: { ledger: Ledger; gateway: GatewayAdmin }) {
    this.#ledger = opts.ledger;
    this.#gateway = opts.gateway;
  }

  /** Pull spend from the gateway into the ledger. Idempotent per (key, window). */
  async syncSpend(keys: GatewayKey[]): Promise<{ debited: number; entries: number }> {
    const byKey = new Map(keys.map((k) => [k.litellmKeyId, k]));
    const rows = await this.#gateway.pullSpend();
    let debited = 0;
    let entries = 0;
    for (const row of rows) {
      const key = byKey.get(row.keyId);
      if (!key) continue;
      const res = await this.#ledger.debit({
        workspaceId: key.workspaceId,
        projectId: key.projectId,
        usd: row.usd,
        idemKey: `spend:${row.keyId}:${row.windowId}`,
        ref: row.keyId,
      });
      if (res.applied) {
        debited += row.usd;
        entries++;
      }
    }
    return { debited, entries };
  }

  /**
   * Push the remaining balance to every key in the workspace. At zero the key is set to
   * a zero budget, which makes the gateway itself refuse the next request.
   */
  async pushBudgets(workspaceId: string, keys: GatewayKey[]): Promise<{ updated: number; blocked: number }> {
    const balance = Math.max(0, microsToUsd(await this.#ledger.balance(workspaceId)));
    let updated = 0;
    let blocked = 0;
    for (const k of keys.filter((x) => x.workspaceId === workspaceId)) {
      const cap = Math.min(k.maxBudgetUsd, balance);
      await this.#gateway.setKeyBudget(k.litellmKeyId, cap);
      updated++;
      if (cap <= 0) blocked++;
    }
    return { updated, blocked };
  }

  /** 80% and 100% thresholds, each fired once per workspace per crossing. */
  async checkAlerts(workspaceId: string, grantedUsd: number): Promise<Alert[]> {
    const balanceMicros = await this.#ledger.balance(workspaceId);
    const grantedMicros = grantedUsd * 1e6;
    if (grantedMicros <= 0) return [];
    const usedFraction = 1 - balanceMicros / grantedMicros;
    const out: Alert[] = [];

    for (const level of [80, 100] as const) {
      const key = `${workspaceId}:${level}`;
      if (usedFraction >= level / 100 && !this.#alerted.has(key)) {
        this.#alerted.add(key);
        out.push({ workspaceId, level, balanceMicros, grantedMicros });
      }
    }
    return out;
  }

  /** Can this project spend right now? Checked before a session is allowed to prompt. */
  async canSpend(workspaceId: string): Promise<{ allowed: boolean; reason?: string; balanceUsd: number }> {
    const balanceUsd = microsToUsd(await this.#ledger.balance(workspaceId));
    if (balanceUsd > 0) return { allowed: true, balanceUsd };
    return {
      allowed: false,
      balanceUsd,
      reason: "No credit remaining. Add your own model key, or request credit from an admin.",
    };
  }
}
