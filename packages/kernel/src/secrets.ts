import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Db } from "./types.ts";
import { KernelError } from "./types.ts";

/**
 * Key-wrapping backend. Swappable below a fixed interface: a local master key for dev,
 * AWS KMS / Vault / age in production. Nothing above this file knows which is in use.
 */
export interface KeyWrapper {
  wrap(dataKey: Buffer): Promise<Buffer>;
  unwrap(wrapped: Buffer): Promise<Buffer>;
}

export class LocalMasterKey implements KeyWrapper {
  #master: Buffer;
  constructor(master: Buffer) {
    if (master.length !== 32) throw new Error("master key must be 32 bytes");
    this.#master = master;
  }

  /**
   * A key that dies with the process. Named so that choosing it is deliberate: every
   * secret wrapped by it is unreadable once this process exits.
   */
  static ephemeral(): LocalMasterKey {
    return new LocalMasterKey(randomBytes(32));
  }
  async wrap(dataKey: Buffer): Promise<Buffer> {
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", this.#master, iv);
    const ct = Buffer.concat([c.update(dataKey), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }
  async unwrap(wrapped: Buffer): Promise<Buffer> {
    const iv = wrapped.subarray(0, 12);
    const tag = wrapped.subarray(12, 28);
    const d = createDecipheriv("aes-256-gcm", this.#master, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(wrapped.subarray(28)), d.final()]);
  }
}

/**
 * Envelope encryption: a fresh data key per record, wrapped by the master key.
 * The database alone leaks nothing, and rotation re-wraps keys without re-encrypting data.
 * Everything else in the platform references secrets by URI and resolves at use time.
 */
export class Secrets {
  #db: Db;
  #wrapper: KeyWrapper;

  constructor(db: Db, wrapper: KeyWrapper) {
    this.#db = db;
    this.#wrapper = wrapper;
  }

  async put(uri: string, tenantId: string, value: string): Promise<void> {
    const dataKey = randomBytes(32);
    const iv = randomBytes(12);
    const c = createCipheriv("aes-256-gcm", dataKey, iv);
    const ct = Buffer.concat([c.update(value, "utf8"), c.final()]);
    const wrapped = await this.#wrapper.wrap(dataKey);
    await this.#db.query(
      `insert into secrets (uri, tenant_id, wrapped_key, iv, tag, ciphertext)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (uri) do update set wrapped_key=$3, iv=$4, tag=$5, ciphertext=$6`,
      [uri, tenantId, wrapped, iv, c.getAuthTag(), ct],
    );
  }

  async get(uri: string): Promise<string> {
    const r = await this.#db.query<{
      wrapped_key: Uint8Array;
      iv: Uint8Array;
      tag: Uint8Array;
      ciphertext: Uint8Array;
    }>(`select wrapped_key, iv, tag, ciphertext from secrets where uri = $1`, [uri]);
    const row = r.rows[0];
    if (!row) throw new KernelError("NO_SUCH_SECRET", `No secret at "${uri}"`, { uri });
    const dataKey = await this.#wrapper.unwrap(Buffer.from(row.wrapped_key));
    const d = createDecipheriv("aes-256-gcm", dataKey, Buffer.from(row.iv));
    d.setAuthTag(Buffer.from(row.tag));
    return Buffer.concat([d.update(Buffer.from(row.ciphertext)), d.final()]).toString("utf8");
  }

  /** Raw stored bytes, for proving the DB holds no plaintext. */
  async rawRow(uri: string): Promise<string> {
    const r = await this.#db.query<{ ciphertext: Uint8Array }>(
      `select ciphertext from secrets where uri = $1`,
      [uri],
    );
    return Buffer.from(r.rows[0].ciphertext).toString("latin1");
  }
}
