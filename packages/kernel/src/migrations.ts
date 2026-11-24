import type { Queryable } from "./types.ts";

/**
 * Kernel schema. Everything here is append-only or derived; nothing is updated in place
 * except stream counters, projection checkpoints, run leases and outbox delivery state.
 */
export const KERNEL_DDL = `
create table if not exists streams (
  stream    text primary key,
  next_seq  bigint not null
);

create table if not exists events (
  id              text primary key,
  -- Assigned from a serialized counter INSIDE the append transaction, so ordinals are
  -- handed out in commit order. The ULID cannot be the cursor: it is minted before
  -- commit, so a transaction holding a lower ULID can commit after a reader has already
  -- advanced past it, and that event is then never projected.
  -- Cost: every append contends on one counter row. Accepted for correctness.
  ordinal         bigint not null,
  stream          text not null,
  seq             bigint not null,
  type            text not null,
  tenant_id       text not null,
  workspace_id    text not null,
  project_id      text,
  actor           jsonb not null,
  at              timestamptz not null,
  payload         jsonb not null,
  idem_key        text,
  causation_id    text,
  correlation_id  text,
  unique (stream, seq)
);
create unique index if not exists events_idem on events (stream, idem_key) where idem_key is not null;
create index if not exists events_type on events (type);
create index if not exists events_scope on events (tenant_id, workspace_id, project_id);
create index if not exists events_correlation on events (correlation_id);
create unique index if not exists events_ordinal on events (ordinal);

create table if not exists outbox (
  id               bigserial primary key,
  event_id         text not null references events(id),
  destination      text not null,
  state            text not null default 'pending',
  attempts         int  not null default 0,
  next_attempt_at  timestamptz not null default now(),
  last_error       text
);
create index if not exists outbox_ready on outbox (state, next_attempt_at);

create table if not exists projection_checkpoints (
  name            text primary key,
  version         int  not null,
  last_event_id   text,
  updated_at      timestamptz not null default now()
);

-- A run pins the exact definition it started with. Without this, editing a graph and
-- restarting the process silently resumed every in-flight run against the new
-- definition, which the design explicitly says is unsupported.
create table if not exists flow_versions (
  id          text primary key,
  kind        text not null,
  version     int  not null,
  graph       jsonb not null,
  digest      text not null,
  created_at  timestamptz not null default now(),
  unique (kind, version)
);
create index if not exists flow_versions_kind on flow_versions (kind, version desc);

create table if not exists flow_runs (
  id              text primary key,
  kind            text not null,
  flow_version_id text references flow_versions(id),
  tenant_id       text not null,
  workspace_id  text not null,
  project_id    text,
  input         jsonb not null,
  state         text not null,          -- queued|running|completed|failed|paused
  output        jsonb,
  error         jsonb,
  attempt       int not null default 0,
  -- Cumulative, so a cost guard survives resumption. In memory it reset on every
  -- attempt, letting a maxCostUsd-guarded loop spend its cap once per attempt.
  spent_micros  bigint not null default 0,
  lease_until   timestamptz,
  created_at    timestamptz not null default now(),
  ended_at      timestamptz
);

create table if not exists flow_steps (
  run_id     text not null references flow_runs(id),
  step_key   text not null,
  state      text not null,             -- started|completed|failed
  idempotent boolean not null default true,
  output     jsonb,
  error      jsonb,
  attempt    int not null default 0,
  -- Held by whichever executor claimed this step. The conditional upsert in
  -- #claimStep refuses a second claim while this is in the future.
  claim_until timestamptz,
  at         timestamptz not null default now(),
  primary key (run_id, step_key)
);

create table if not exists secrets (
  -- Keyed by tenant AND uri. With uri alone, two tenants using the documented
  -- secret://workspace/... shape collide: one overwrites the other and either can read it.
  tenant_id     text not null,
  uri           text not null,
  wrapped_key   bytea not null,
  iv            bytea not null,
  tag           bytea not null,
  ciphertext    bytea not null,
  created_at    timestamptz not null default now(),
  primary key (tenant_id, uri)
);
`;

export async function migrate(q: Queryable): Promise<void> {
  for (const stmt of KERNEL_DDL.split(";\n").map((s) => s.trim()).filter(Boolean)) {
    await q.query(stmt);
  }
}
