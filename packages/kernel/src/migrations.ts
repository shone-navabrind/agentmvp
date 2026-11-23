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

create table if not exists flow_runs (
  id            text primary key,
  kind          text not null,
  tenant_id     text not null,
  workspace_id  text not null,
  project_id    text,
  input         jsonb not null,
  state         text not null,          -- queued|running|completed|failed|paused
  output        jsonb,
  error         jsonb,
  attempt       int not null default 0,
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
  at         timestamptz not null default now(),
  primary key (run_id, step_key)
);

create table if not exists secrets (
  uri           text primary key,
  tenant_id     text not null,
  wrapped_key   bytea not null,
  iv            bytea not null,
  tag           bytea not null,
  ciphertext    bytea not null,
  created_at    timestamptz not null default now()
);
`;

export async function migrate(q: Queryable): Promise<void> {
  for (const stmt of KERNEL_DDL.split(";\n").map((s) => s.trim()).filter(Boolean)) {
    await q.query(stmt);
  }
}
