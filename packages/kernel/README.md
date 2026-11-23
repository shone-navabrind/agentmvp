# @harness/kernel

Tier 0 of the platform (see `docs/ARCHITECTURE.md` §2). Fixed, not pluggable: everything
else is built on exactly this surface.

| Module | Responsibility |
|---|---|
| `registry.ts` | Event schema registry. Unregistered or invalid events are a hard error; superseded types stay readable via upcaster chains. |
| `log.ts` | Append-only event log. Gapless per-stream sequence, idempotency keys, causation/correlation, atomic with the caller's own writes. |
| `projections.ts` | Derived read models. Checkpointed, incrementally caught up, rebuildable from the log alone. |
| `steps.ts` | Durable step runtime. Memoised side effects, crash recovery, lease-based orphan detection, budget guards. |
| `authz.ts` | One capability check for users, agent sessions, flow runs and plugins. |
| `secrets.ts` | Envelope encryption with a swappable key-wrapping backend. |
| `outbox.ts` | Transactional outbox: at-least-once delivery, backoff, dead letters. |
| `db.ts` | The only SQL surface. PGlite driver here; a `pg` Pool driver is the same ~20 lines. |

## Run

```
npm install
npm test        # 60 tests, no external services -- PGlite is a real Postgres in-process
npm run typecheck
```

## The two acceptance tests that matter

`docs/ARCHITECTURE.md` gates milestone K1 on these; both are in the suite by name:

- **`K1 ACCEPTANCE: a run killed mid-flight resumes and produces identical output`**
  A provisioning flow is interrupted after enrolment. A second worker resumes it: completed
  steps replay from stored results (proven by side-effect counters), only the remaining step
  executes, and the output is deep-equal to an uninterrupted run.
- **`K1 ACCEPTANCE: replay rebuilds a projection byte-identically`**
  A board read model is dropped entirely and rebuilt from the log -- including one
  pre-migration event that must upcast on the way through -- and hashes identically.

## Not yet built

Sandbox protocol (the fifth kernel concern), RLS policies, OpenTelemetry spans,
a `pg` driver, event partitioning and cold-tier retention.
