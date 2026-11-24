# Critic report blockers — disposition

Twelve blockers in `.egm/critic_report.md`. Nine are closed with regression tests; two
are documentation work; one is deferred with a reason.

| # | Blocker | State | Where |
|---|---|---|---|
| D1 | `authz` wired to nothing | **fixed** | `apps/api/src/server.ts` — every route declares a capability, checked before its handler. 4 tests. |
| D2 | Secrets readable across tenants | **fixed** | keyed on `(tenant_id, uri)`; `get()` takes a tenant. 2 tests. |
| D3 | Cursor could skip committed events | **fixed** | commit-order `ordinal` from a serialized counter; projections cursor on it. 2 tests. |
| D4 | No worker, queue or lease renewal | **fixed** | `packages/kernel/src/worker.ts` — atomic claim, lease renewal, orphan recovery. 5 tests. |
| D5 | `step()` check-then-act race | **fixed** | one conditional upsert claims a step; losers get `StepHeldElsewhere`. 3 tests, one a real race. |
| D6 | Runs pinned nothing | **fixed** | `flow_versions` with content digests; `start()` pins the newest. 4 tests. |
| D7 | Egress allowlist defaulted to allow-all | **fixed** | default-deny, workspace ∩ node, https-only, redirects re-checked per hop. 8 tests. |
| D9 | Secrets compiled into the graph and event log | **fixed** | declared-secret inputs stay as `${HC_SECRET_*}` references. 5 tests. |
| F1 | Guard budgets reset on resumption | **fixed** | spend persisted on the run. 1 test. |
| F2 | Two executors double-execute | **fixed** | same mechanism as D5. |
| S1 | No rollback for provisioning | **fixed** | `compensate()` on `NodeType`; reverse-order unwind on terminal failure. 4 tests. |
| D8 | Blueprints undocumented | **doc** | see below. |

## D8 — the blueprint subsystem is now in the architecture

`packages/blueprints` is 1,341 lines defining a first-class entity, and
`ARCHITECTURE.md` did not mention it. §1 now carries Blueprint in the object model, §15
lists its tables, §16 gives it a milestone, and §13 covers model-authored environment
definitions.

## Two things the fixes revealed

**The unwind was running on every failed attempt.** Releasing a sandbox after a
retryable failure destroys exactly what the next attempt resumes into. `StepCtx` now
exposes `willRetry(err)` so a graph only unwinds when nothing will try again, and
compiled graphs are `maxAttempts: 1` — a graph run resumes via the worker reclaiming an
expired lease, it does not retry in place.

**Nothing inside an unwind may change a run's fate.** The first version emitted a
`flow.unwound` event; where that type was unregistered the emit threw, and the
*retryable* error replaced the original failure, turning `failed` into `queued`. The
unwind is now defensive end to end.

## Still open, deliberately

- **No Postgres RLS.** `§15` calls it required. The repository layer scopes every query
  by tenant and the secrets table is now keyed by it, but defence in depth is missing.
  Needs the networked Postgres that K2 brings; PGlite is single-tenant by construction.
- **`Secrets.get()` takes a tenant but no subject**, so capability checks on secret
  reads are still owed. The call sites that need them do not exist yet.
- **Compensators exist for the contract, not for provisioning.** `provision.*` node
  types are still unimplemented (D10), so there is nothing yet to compensate.
