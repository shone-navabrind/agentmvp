# Stage 7 — Critic review (design + structural)

Scope reviewed: `docs/ARCHITECTURE.md` against `packages/kernel/src`, `packages/blueprints/src`,
`packages/flow/src`, `packages/sandbox/src`, `packages/compute/src`. Tests read only where a test is
the sole evidence for a claim. `docs/STATUS.md` and `apps/api/src/demo-data.ts` read as corroboration
for what is wired in production code versus what exists only as an exported function.

Counts: **12 BLOCKER · 30 MAJOR · 9 NIT** (51 findings)

- §1 design–code divergence (D1–D25): 9 BLOCKER, 13 MAJOR, 3 NIT
- §2 design defects (F1–F19): 2 BLOCKER, 12 MAJOR, 5 NIT
- §3 structural (S1–S7): 1 BLOCKER, 5 MAJOR, 1 NIT

---

## 1. Design–code divergence

### D1. `authz` is wired to nothing. BLOCKER

Doc §2.3: "One module. **Every** API handler, WS upgrade, MCP tool, flow node and plugin call goes
through it." §2.4: secret "Resolution is capability-checked and audited." §3 hard rule 2:
capabilities are "enforced at call time". §10: "Everything above goes through `authz` with the same
capability names."

Code: the only call to `can()` outside `packages/kernel/src/authz.ts` and its own test is
`apps/api/src/server.ts:148`, which *reports* decisions to the UI:

```ts
decisions: Object.fromEntries(caps.map((c) => [c, k.authz.can(s, c, resource).allowed])),
```

`Authz.assert()` has zero production call sites. `Secrets.get()`
(`packages/kernel/src/secrets.ts:71`) takes a URI and nothing else — no subject, no capability, no
`onDecision` hook. `StepRuntime.resume()` (`steps.ts:110`), `awaitingDecision()` (`steps.ts:134`) and
`recoverable()` (`steps.ts:142`) take no subject. The capability layer exists; nothing is behind it.
The doc's claim is not "partially true" — it is false at every one of the five named call sites.

### D2. Secrets are keyed by URI alone and are readable across tenants. BLOCKER

Doc §2.4: "Envelope encryption, per-record data keys… Resolution is capability-checked and audited."
§15: "Tenant id on every row; enforced in the repository layer **and** Postgres RLS. Not 'if
feasible' — required, because plugins now execute code near your data."

`packages/kernel/src/migrations.ts:80-88` makes `uri` the primary key and `tenant_id` an ordinary
column. `Secrets.put` (`secrets.ts:63-68`) upserts `on conflict (uri) do update`, and `Secrets.get`
(`secrets.ts:77`) is `select … from secrets where uri = $1` — `tenant_id` is written and never read.
With doc-shaped URIs (`secret://workspace/jira-token`) two tenants collide by construction: tenant B's
`put` silently overwrites tenant A's value, and either tenant's `get` returns it. No RLS policy exists
anywhere in the repo (`grep -i "row level\|policy"` → no hits in any migration).

### D3. The event-log cursor can skip committed events permanently. BLOCKER

Doc §2.1: "`id: string; // ULID, globally monotonic`". `log.ts:126`: "Global cursor read. `afterId`
is a ULID, so this is a stable, gapless cursor." §2.1: "Board state = a projection; replay rebuilds
it." §16 K1 acceptance: "Replay rebuilds a projection byte-identically."

`ulid()` (`packages/kernel/src/ulid.ts:33-41`) is monotonic only within one process: `lastMs`/`lastRand`
are module-level. Two API processes, or two transactions in one process, mint ids with no ordering
relationship to commit order. `EventLog.append` (`log.ts:84`) mints the id *before* the insert, inside
a transaction of unbounded duration. `ProjectionRunner.run` (`projections.ts:65-77`) advances
`last_event_id` to the highest id in the batch. A transaction that minted a lower id and committed
later is `id > cursor`-invisible forever: the projection never sees it, and no error is raised. Board
state, chat history and audit views all silently lose events under concurrency. A `lastMs` regression
from NTP adjustment produces the same loss in a single process.

This also makes the §16 K1 acceptance claim untestable as written: a byte-identical rebuild is
measured against a projection that may itself have skipped rows.

### D4. No worker, no queue, no lease renewal — "another worker picks it up" is not implemented. BLOCKER

Doc §2.2: "Postgres-backed (`pg-boss` or `graphile-worker`) with a checkpoint model on top". §7:
"Worker dies → another picks it up". §16 K1: "kill a worker mid-run; the run resumes."

There is no queue library, no polling loop, no `setInterval`, no `for update skip locked` anywhere in
the repo. `StepRuntime.recoverable()` (`steps.ts:142-148`) returns expired-lease run ids and has one
caller — a test. `execute()` sets `lease_until = now + leaseMs` once (`steps.ts:192-195`, default
30 s) and never renews it, and never checks it still owns the lease. Any flow with a node longer than
the lease — `agent.turn`, a build, `approval.wait` before it suspends — is declared recoverable while
it is still running.

The K1 acceptance test (`steps.test.ts:55-100`) simulates the crash by throwing inside the same
process and re-calling `execute()` sequentially. It establishes memoisation, not worker recovery, and
there is no test with two concurrent executors.

### D5. `step()` is a check-then-act race; the at-most-once guard does not hold. BLOCKER

Doc §2.2: "Non-idempotent nodes must declare themselves so and get an **at-most-once guard** plus a
compensation hook."

`steps.ts:229-247`: read `flow_steps` (line 231), decide, then `insert … on conflict do update set
state='started'` (line 246), then run the side effect (line 249). The read and the write are separate
statements on the pool, not one transaction and not a conditional update. Two executors on the same
run — which D4 guarantees will happen, because the lease expires mid-run — both read "no row", both
mark started, both execute. For `idempotent: false` that is the double-charge the guard exists to
prevent; `AmbiguousStep` only fires on a *later* attempt, after the damage.

Also: the compensation hook named in §2.2 and the `compensate?(ctx, input, output)` member of §7's
`FlowNode` do not exist. `NodeType` (`packages/flow/src/types.ts:63-73`) has `idempotent` and
`suspends` and no compensation. Nothing anywhere calls a compensator.

### D6. Flow runs pin nothing; `flows` / `flow_versions` do not exist. BLOCKER

Doc §7: "A run pins its flow definition version at start. Editing a flow never mutates in-flight runs.
Resuming an interrupted run uses the pinned version." §15 lists `flows(id, project_id, name)` and
`flow_versions(id, flow_id, version, graph jsonb, created_by)`, and `flow_runs(id, flow_version_id,
…, trigger_id, …, cost_micros)`.

`migrations.ts:52-66`: `flow_runs` has `kind text` and no `flow_version_id`, no `trigger_id`, no
`cost_micros`. `execute()` resolves the definition from an in-memory map at run time
(`steps.ts:188`: `this.#defs.get(row.kind)`). `compileGraph` derives the kind from the graph *name*
(`runner.ts:28`: `kind: graph:${g.name}`), and `register()` throws on a duplicate kind
(`steps.ts:74`). So editing a flow either (a) throws at boot, or (b) if the process restarts with the
edited graph under the same name, every in-flight run resumes against the new definition — the exact
behaviour §7 says is unsupported. No graph JSON is persisted anywhere, so a run cannot be resumed by a
process that does not already hold the author's code.

`flow_steps` (`migrations.ts:68-78`) likewise drops `node_id`, `input` and `checkpoint` from the §15
shape and makes `(run_id, step_key)` the PK, so per-attempt history — the thing a run timeline with
"retry / skip / resume-from-step controls" (§7) renders — is overwritten, not accumulated.

### D7. Node-level egress allowlist defaults to "allow everything". BLOCKER

Doc §13.4: "`http.request` and connector nodes run in the control plane with workspace credentials —
a prompt-injected agent that can *author a flow* escalates. So: … **node-level egress is allowlisted
per workspace**." §3 manifest: `"http:egress:api.atlassian.com"`.

`packages/flow/src/nodes.ts:116-126`:

```ts
allowHosts: z.array(z.string()).default([]),
…
if (config.allowHosts.length && !config.allowHosts.includes(host)) { throw … }
```

An empty allowlist — the default, and what any author who omits the field gets — permits every host.
The allowlist is per *node config*, i.e. supplied by whoever authored the flow, not per workspace, so
the attacker in the doc's own threat model writes their own policy. There is no workspace-level
allowlist anywhere in the code. The check also runs once against `input.url` before `fetch`, which
follows redirects by default: a permitted host that 302s to `169.254.169.254` is not re-checked.

### D8. Blueprints: an entire subsystem with no design. BLOCKER

`packages/blueprints` (1,341 lines across schema, validate, compile, synthesize, catalog) defines a
new first-class entity that owns sandbox sizing, service topology, data seeding with "neutralize"
recipes over production dumps, declared secret inputs, shell setup steps, and AI synthesis of all of
it from a sentence. `ARCHITECTURE.md` mentions none of it. §1's object model has `Bundles[]` and no
Blueprint; §16's build order has no blueprint milestone (`STATUS.md` lists it with `—` where every
other row has a K-number); §15's data model has no blueprint table; §13's security deltas do not
discuss model-authored environment definitions.

This is the single largest gap between the document and the system. Everything in §2 (§D9, §D10
below) is also unapplied to it: a blueprint is not an event, not a versioned entity, and not a
projection.

### D9. Secret values are compiled into the graph and into the event log in plaintext. BLOCKER

Doc §2.4: "Everything else references secrets by URI (`secret://workspace/jira-token`) and resolves at
use time, **never at storage time**."

`packages/blueprints/src/schema.ts:84` declares `inputSlot.secret: boolean`. Nothing honours it.
`compileProvisioning` (`compile.ts:199`) substitutes binding values directly into the persisted graph:

```ts
config: { step: { ...step, script: interpolateShell(step.script, bp, b) } },
```

and `renderCompose` (`compile.ts:267`) does the same into compose `environment:`. That graph is the
input to a flow run — `flow_runs.input jsonb` (`migrations.ts:58`) — and is emitted as event payloads,
in a log the doc calls "append-only, already immutable" and tiers to object storage after N days. A
secret written there cannot be rotated out. `interpolateShell` shell-quotes the value, which stops
command injection and does nothing about storage.

### D10. The provisioning graph cannot run. MAJOR

`compile.ts:316-318` states: "Provisioning is not a bespoke state machine: it is an ordinary flow run
on the kernel's durable step runtime."

`compileProvisioning` emits node types `provision.acquire-sandbox`, `provision.attach-repos`,
`provision.write-compose`, `provision.restore-seed`, `provision.run-step`,
`provision.start-services`, `provision.verify`, `provision.apply-bundles`
(`compile.ts:154-226`). None is registered in any `NodeRegistry`; the only `provision.*` identifier
elsewhere is the *event* type `provision.progress` (`demo-data.ts:34`). `compileGraph` calls
`reg.assertValid(g)` (`runner.ts:19`), which rejects "node `x` uses unregistered type"
(`registry.ts:42`). The only production caller, `demo-data.ts:305`, builds the graph and renders it;
it never compiles or executes it. The comment describes an integration that does not exist.

### D11. Capability negotiation never receives the project's requirements. MAJOR

Doc §4: "A project spec declares what it *needs* (`needsDocker`, `needsSnapshot`, `minIsolation`). The
scheduler filters drivers by capability… A feature that needs snapshots is simply unavailable (with a
clear reason in the UI) on a driver that lacks them — **never silently degraded**."

`SandboxSpec.requires` is optional (`compute/src/driver.ts:34-40`) and `filterCapable` short-circuits
every check when it is absent (`driver.ts:96-116`). Blueprints declare exactly the fields §4 names —
`sandbox.minIsolation: "vm"`, `needsDocker: true` (`blueprints/src/schema.ts:144-145`, and every
catalog entry, e.g. `catalog.ts:16`) — and nothing maps them to `requires`: `needsDocker`'s only
consumer is a validation message (`validate.ts:150`). The one production `acquire()` call
(`demo-data.ts:63-68`) passes no `requires`, so a blueprint demanding VM isolation is placed on
`LocalProcessDriver`, whose `capabilities().isolation` is `"host"` (`drivers/local.ts:35`). That file's
own comment says "policy must refuse it for untrusted tenants"; no policy check exists. This is the
silent downgrade §4 and §16 K13 forbid by name.

### D12. Compute placement and session state live in process memory. MAJOR

Doc §15 lists `compute_hosts(id, driver, capacity, allocatable, state)` and `sessions(id, project_id,
task_id, harness, model, branch, worktree_path, state, cgroup_scope, port_range, created_by,
last_active_at)`. Doc §1: "A session is addressable, resumable and attachable. It survives sandbox
stop/start."

`HostPool` holds hosts and allocations in two `Map`s (`compute/src/host-pool.ts:31-32`).
`SessionManager` holds sessions in a `Map` (`sandbox/src/sessions.ts:57`). Neither persists, neither
emits an event, neither has a table. A control-plane restart returns an empty allocation table, after
which `fits()` reports the full host free and the scheduler places new sandboxes on top of the running
ones — the OOM-by-oversubscription failure §4 and §5.4 are written to prevent — and every session
record (branch, port range, cgroup scope) is lost while the worktrees remain on disk.

### D13. Built-in flow node types are mostly absent and renamed. MAJOR

Doc §7: "Built-in node types: `llm.agent`, `shell.run`, `http.request`, `git.commit` / `git.pr`,
`approval.wait` …, `condition`, `map`, `loop`, `subflow`, `wait.event`, `wait.until`."

`packages/flow/src/nodes.ts` provides `core.const`, `core.check`, `core.increment`, `core.approval`,
a `mapNode` factory, `agent.turn` and `http.request`. Missing: `shell.run`, `git.commit`, `git.pr`,
`condition`, `loop`, `subflow`, `wait.event`, `wait.until`. Renamed without a note: `llm.agent` →
`agent.turn`, `approval.wait` → `core.approval`. `standardNodes()` (`nodes.ts:145-151`) registers four
nodes, none of which does I/O. §16 K6's acceptance ("cross-repo change in one session opens two linked
PRs") has no node to execute it, and §8's "`approval.wait` nodes … appear as cards automatically"
names a type that does not exist.

### D14. Typed edges check reference paths, not schema satisfaction. MAJOR

Doc §7: "**Typed edges.** A node's `outputSchema` must satisfy the next node's `inputSchema` —
checked at *save* time in the editor."

`NodeRegistry.validate` (`registry.ts:28-117`) checks required input keys are mapped
(`registry.ts:50-54`) and that each `$.nodes.<id>.<path>` names a field the source *can* produce
(`registry.ts:68`). It never compares the referenced field's type to the consumer's expected type: a
`z.string()` output mapped into a `z.number()` input saves cleanly and fails at run time. Worse,
`pathExists` returns `null` ("cannot tell") for arrays, unions, records and `z.unknown()`
(`schema-introspect.ts:30-33, 60-69`), and the shipped `core.const` / `core.check` outputs are
`z.unknown()` (`nodes.ts:11, 22`) — so for the default node set the check is vacuous. Edges
themselves (`g.edges`) are validated only for existence of endpoints (`registry.ts:77-80`).

### D15. `append`'s idempotency behaviour is two different contracts. MAJOR

Doc §2.1: "`idemKey?: string; // unique per (stream, idemKey)`". Doc §10: "Idempotency keys on
creates."

`log.ts:66-71` reads for a prior row and returns it — a dedupe-and-return contract. `log.ts:98-103`
catches the unique-index violation and throws `DuplicateEvent` — a reject contract. Which one a caller
gets depends on whether a concurrent appender committed between the select and the insert. A producer
retrying after a timeout therefore sometimes gets the original event back and sometimes an exception,
and no caller can be written correctly against both.

### D16. Auto-commit protects nothing, and is never invoked. MAJOR

Doc §11: "the sandbox is disposable; **the git remote is the source of truth.** Uncommitted work is
protected by auto-commit to the session branch on idle/suspend, not by VM snapshots."

`WorktreeManager.autoCommit` (`worktrees.ts:123-131`) commits to the local bare clone and does not
push. `SessionManager.suspend` (`sessions.ts:145-149`) and the idle reaper
(`sessions.ts:167-172`) never call it — `autoCommit` has no caller outside `sandbox.test.ts`. On a
disposable sandbox, a commit that never reaches the remote is destroyed with the VM, so the mechanism
the doc names as the durability story provides no durability even when it is called.

### D17. Session isolation is directories only; §13.2's named boundary is absent. MAJOR

Doc §13.2: "Session A must not read session B's worktree: **separate uid or mount namespace per
session, not just separate directories.** Decide and test this explicitly — it is a real tenancy
boundary now."

`worktreePath` is `join(workRoot, sessionId, repo)` (`worktrees.ts:49-51`) and `systemdRunArgs`
(`sessions.ts:178-193`) sets `MemoryMax`, `MemoryHigh`, `CPUWeight`, `TasksMax`, `IOWeight` — no
`User=`, no `PrivateTmp=`, no namespace properties. Separate directories, same uid, no namespace:
precisely the state the doc says is insufficient. §5.3's netns for port reuse is likewise absent;
`#allocatePorts` (`sessions.ts:98-109`) hands out numeric ranges and nothing enforces them.

### D18. Session resume after archive is broken by the branch-naming scheme. MAJOR

Doc §5: "Session close → branch retained, worktree pruned." "Suspend keeps the worktree and harness
session file; resume is seconds. Archive prunes the worktree, keeps the branch."

`createWorktree` always runs `git worktree add -b <branch>` (`worktrees.ts:88`) with
`branch = session/<sessionId>` (`worktrees.ts:53-55`). `removeWorktree` prunes the worktree and keeps
the branch (`worktrees.ts:134-139`). Re-creating the worktree for that session — the resume path the
doc promises — fails with "a branch named 'session/x' already exists". There is no `--no-checkout`,
no existence check, no reattach path.

### D19. Cancellation is declared and not implemented. MAJOR

Doc §7 `NodeCtx`: "`signal: AbortSignal; // cancellation propagates`."

`steps.ts:202` constructs `new AbortController()` whose `abort()` is never called, from anywhere.
`StepRuntime` exposes no `cancel(runId)`. `runner.ts:95` forwards the same inert signal into every
node. No node in `nodes.ts` reads `ctx.signal` — including `httpNode`, which does not pass it to
`fetch` (`nodes.ts:128-132`). A paused, looping or runaway run cannot be stopped by any mechanism
other than killing the process.

### D20. Outbox lacks signing, circuit breaking and replay. MAJOR

Doc §10: "retries with exponential backoff, DLQ after N attempts, **signed payloads (HMAC + timestamp
+ replay window), per-destination circuit breaker, and manual replay from the log**."

`packages/kernel/src/outbox.ts` implements backoff (`:32`), attempts and a `dead` state (`:94-99`).
There is no HMAC, no timestamp, no replay window, no per-destination failure accounting or breaker,
and no replay method — `deadLettered()` (`:43`) lists dead rows and nothing can re-enqueue them. §3
hard rule 6's "circuit-broken, disabled after N failures" exists for plugins and not for the egress
path where the doc puts it.

### D21. Events are not partitioned, not retained, not immutable at the database. MAJOR

Doc §2.1: "Retention: hot in Postgres, cold tiered to object storage after N days, with the
projections kept warm." §15: "`events(…)` -- append-only, partitioned by month". §2.1: "Audit = …
Append-only, already immutable."

`migrations.ts:13-32` creates a plain table with no partitioning, no tiering job, and no `revoke` /
rule / trigger preventing `update` or `delete`. "Already immutable" is a property of the code path, not
of the data: any component holding the `Db` handle — and `Db` is handed to every package constructor —
can rewrite audit history with one statement. The test suite demonstrates the capability
(`outbox.test.ts:185` mutates `secrets` directly through the same handle).

### D22. `readAll` has no scope filter, so projections cannot be per-tenant. MAJOR

Doc §15: "Tenant id on every row; enforced in the repository layer and Postgres RLS."

`EventLog.readAll` (`log.ts:127-139`) filters on `afterId` and `types` only. `ProjectionRunner`
(`projections.ts:65`) uses it, so every projection is global: a workspace-scoped board must read every
tenant's events to build itself. Combined with D2 (no RLS) the repository layer offers no scoping
primitive at all.

### D23. `ComputeDriver` signature drift from §4. NIT

Doc §4 declares `metrics(ref): Promise<{ cpu, memBytes, diskBytes }>` and no `state()`.
`compute/src/driver.ts:65-66` declares `state(ref)` and `metrics(ref): Promise<{ cpuPct, memMiB,
diskGiB }>`. Both drivers return `cpuPct: 0` unconditionally (`local.ts:92`, `incus.ts:167`). §12's
right rail ("active sessions and their cgroup usage") and §17.6 ("Instrument cost per project per
day from K2") have no numbers to show.

### D24. `Event.seq` is `string`, doc says `bigint`. NIT

`types.ts:17` with a comment explaining JSON. Harmless, but the doc's §2.1 block is presented as the
contract and three of its fields (`seq`, `projectId` optionality, `at`) differ from `types.ts:14-28`.

### D25. Outbox column is `destination`, §15 says `destination_id`. NIT

`migrations.ts:38` vs §15's `outbox(id, event_id, destination_id, …)`. The code treats destinations as
free-form strings (`log.ts:34`) with no destination registry, so there is nothing for an id to
reference — which is the real divergence; the column name is the symptom.

---

## 2. Design defects

### F1. Guard budgets reset on every resumption, so `maxCostUsd` and `maxWallClockMs` bound nothing. BLOCKER

Doc §7: "**Loops need guards, always.** `maxIterations`, `maxCostUsd`, `maxWallClockMs`, and a stall
detector… An unguarded agent loop against a metered gateway is an incident." §16 K7 acceptance: "a
loop halts on cost guard."

`ctx.budget` is a closure over `let spent = 0` created fresh inside each `execute()`
(`steps.ts:203, 211-219`); it is never persisted. `compileGraph`'s run function re-initialises
`startedAt = Date.now()`, `steps = 0`, `stallCount = 0` on every entry (`runner.ts:33-37`). Memoised
steps return stored output without re-entering `type.execute`, so `agentNode`'s `ctx.budget.charge`
(`nodes.ts:104`) is *not* replayed — after any resume, `spentUsd()` reads 0 while real money has been
spent. The compiled graph sets `maxAttempts: 25` (`runner.ts:29`), so a cost-guarded loop can legally
spend 25× its cap, and a wall-clock-guarded flow can run 25 full windows. `flow_runs` has no
`cost_micros` column (D6) to persist it into.

The same closure is the only thing behind `opts.budgetUsd`, which `execute()` asserts **after**
`def.run()` returns (`steps.ts:273`) — i.e. after all spend has already happened. It can report an
overspend; it cannot prevent one.

### F2. Two executors on one run double-execute side effects. BLOCKER

Covered mechanically in D4/D5; recording it here as the design hazard: there is no run-level mutual
exclusion. `execute()` does not check `state`/`lease_until` before taking the run (`steps.ts:184-195`
accepts anything not `completed`/`failed`), does not CAS on the lease, and stores no owner. The lease
is advisory data that one unused query reads. Every ordering guarantee downstream — step memoisation,
`AmbiguousStep`, the approval gate — assumes single-writer and nothing enforces it.

### F3. `attempt` conflates retry-after-failure with resume-after-human. MAJOR

`resume()` sets the run back to `queued` (`steps.ts:129`); `execute()` then increments `attempt`
(`steps.ts:191`). A flow with several approval gates burns one "attempt" per human answer, so a flow
whose `maxAttempts` is the default 3 (`steps.ts:288`) treats its first genuine error after three
approvals as terminal. `compileGraph` papers over this with `maxAttempts: 25` and a comment —
"attempts are resumptions, not retries of work" (`runner.ts:29`) — which concedes the counter means
two different things and picks a number large enough to hide it, at the cost of letting a genuinely
broken graph retry 25 times.

### F4. A paused run stores its question in the `error` column. MAJOR

`steps.ts:282-285` writes `serializeError(SuspendRun)` into `flow_runs.error`, and
`awaitingDecision()` (`steps.ts:134-139`) mines `error.details.question` to build the approval inbox.
`STATUS.md` records fixing exactly this confusion at the *step* level ("A suspended step was recorded
as `failed`"); the run level still encodes "waiting for a person" as an error object. Every consumer
that reasonably treats `flow_runs.error IS NOT NULL` as "this run has a problem" — the board card
raiser in §8, any alerting — is wrong for the most common pause in the system.

### F5. `resume()` can inject any step result, unauthenticated. MAJOR

`steps.ts:110-131` validates only that the run is `paused`. It does not check that `stepKey` is the
step that suspended (the suspended key is recoverable from `error.details.stepKey` and is ignored), it
writes `idempotent: true` over whatever the step declared, and `answer` is written to `flow_steps.output`
with no schema validation. The node's `outputSchema` is applied only after `ctx.step` returns
(`runner.ts:106`), so a malformed answer fails the run at an unrelated point with `StepOutputInvalid`
rather than being rejected at the boundary. There is no subject, no capability check and no audit event
for a human decision — the one action in the system whose provenance matters most (§13.4: "agent-authored
flows land as drafts needing human approval").

### F6. Outbox drain is not claim-based: concurrent workers deliver twice. MAJOR

`Outbox.drain` (`outbox.ts:56-66`) selects pending rows with no `for update skip locked`, no claim
column, and no state transition before delivery; the row is only updated *after* `deliver()` returns
(`outbox.ts:82-100`). Two delivery workers — the doc assumes a worker pool — send the same payload.
`outbox.ts:13-17` calls this "at-least-once", which is honest, but §2.1 sells the outbox as
"exactly-once-ish delivery" and §10 adds no deduplication token to the delivery contract, so the
receiver has nothing to dedupe on. Unsigned (D20) and undeduplicated is the worst combination for an
egress webhook.

### F7. `http.request` is non-idempotent for every method, which makes GETs unresumable. MAJOR

`nodes.ts:111` comments "Non-idempotent for unsafe methods"; `nodes.ts:121` sets `idempotent: false`
unconditionally, for a schema whose default method is `GET` (`nodes.ts:116`). Any interrupted HTTP
node therefore trips `AmbiguousStep` on resume (`steps.ts:240-241`), which is `retryable: false`
(`types.ts:132`), which ends the run immediately (`steps.ts:290-291`). A flow that polls a status URL
cannot survive a single worker restart.

### F8. Compose rendering does not escape `$`, so inputs reach Docker Compose's own interpolator. MAJOR

`renderCompose` (`compile.ts:267, 278`) emits user-bound values into YAML with `JSON.stringify`, which
escapes quotes and leaves `$` intact. Docker Compose interpolates `${VAR}` and `$VAR` in the compose
file from the host environment before starting anything. An input value containing `${HOME}` or
`$AWS_SECRET_ACCESS_KEY` is substituted from the sandbox host's environment into a container's env or
volume path. `interpolateShell` guards the setup-script path (`compile.ts:199`); the compose path uses
plain `interpolate` (`compile.ts:261, 267, 278`) and has no equivalent `$` → `$$` escaping.

### F9. The warm pool hands out sandboxes of the wrong size. MAJOR

`Scheduler.acquire` matches a warm entry on `imageVersion` and driver capability only
(`scheduler.ts:83-89`); `WarmEntry` (`scheduler.ts:17`) does not even record the size it was booted
with. A project asking for 8 vCPU / 16 GiB receives the 2 vCPU / 4 GiB warm box
(`demo-data.ts:58-68` shows the shape), and `HostPool` keeps accounting for the warm size — so the
allocation table and reality diverge in the direction of overcommit. §5.4's `maxSessions` is then
computed from a size the sandbox does not have.

### F10. `needsReview` is an unenforced privilege boundary. MAJOR

Doc §13.4: "agent-authored flows land as drafts needing human approval". `synthesize.ts:124-126`
asserts the same intent in a comment: "Synthesised blueprints are marked as such and reviewed before
their first run: an environment definition is executable, so this is a privilege boundary."
`needsReview` (`synthesize.ts:152`) is called only from `blueprints.test.ts:375`. Nothing in
`compileProvisioning` (`compile.ts:140`), in the catalog, or in the API consults it; a synthesised
blueprint compiles to a provisioning graph carrying model-authored shell scripts with no gate between
synthesis and execution. `saveAsTemplate` takes `approvedBy` (`synthesize.ts:141`) and discards it:
the approval of an executable artifact leaves no record, in a system whose §2.1 premise is that every
state change is an event.

### F11. Admission control's `force` flag inverts its own name, and queued sessions hold ports. MAJOR

`admit()` (`sessions.ts:115-133`): `if (atCapacity && opts.force) throw new AtCapacity(...)`. `force`
makes admission *fail* where the default queues. Any caller reading the name as "admit anyway" gets the
opposite behaviour at exactly the moment capacity is tight. Separately, the doc-echoing comment says "A
queued session holds no resources" (`sessions.ts:112`) while the same function allocates a port block
to a queued session (`sessions.ts:126` → `#allocatePorts`, which excludes only `archived`), so a queue
of waiting sessions exhausts the 1,000-block port space (`sessions.ts:104`).

### F12. `transition()` permits any state change. MAJOR

Doc §5 states one lifecycle: `queued → starting → active → idle(ttl) → suspended → archived`.
`sessions.ts:135-142` assigns whatever state it is handed, so `archived → active` and
`queued → archived` are legal, and `#promoteQueued` (`sessions.ts:157-163`) promotes to `starting`
based on a count that any illegal transition can corrupt. There is no transition table and no test of
an illegal transition.

### F13. `migrate()` is a DDL blob with no version table. MAJOR

`migrations.ts:91-95` splits `KERNEL_DDL` on `";\n"` and runs each statement; every statement is
`create … if not exists`. There is no `schema_migrations` table, no ordering, no down-path, and no way
to alter an existing table — so the first change to `events` or `flow_steps` after a deployment has no
mechanism to apply. §3 hard rule 4 ("Plugins own their own Postgres schema… Uninstall drops the
schema") presumes a migration runner that does not exist for the core, let alone per-plugin. Splitting
on `";\n"` also breaks on any future function body or `do $$` block.

### F14. The enrollment token is passed on the Incus command line. MAJOR

`incusArgv.launch` (`drivers/incus.ts:31-37`) embeds the cloud-init payload — containing
`spec.enrollmentToken`, the bearer credential a sandbox exchanges for its mTLS client certificate
(§2.5) — as an `--config` argv element. Process arguments are world-readable in `/proc` on the host
and are captured by any command logging or shell history. `LocalProcessDriver` redacts the same field
when writing `sandbox.json` (`drivers/local.ts:65`), which shows the sensitivity was recognised in one
driver and not the other.

### F15. Repo and session identifiers are interpolated into filesystem paths unvalidated. NIT

`barePath` (`worktrees.ts:45-47`) and `worktreePath` (`:49-51`) `join()` caller-supplied `repo` and
`sessionId` with no character validation; `addRepo` passes `${repo.name}.git` to `git clone`
(`:60`). `join` normalises `..`, so a crafted name escapes `gitRoot`/`workRoot`. `RepoRef`
(`:26`) imposes no pattern, unlike the blueprint schemas, which do (`blueprints/src/schema.ts:32, 48`).

### F16. Upcasters run on every read with no cache. NIT

`EventLog.#hydrate` calls `registry.upcast` per row (`log.ts:40`), walking the chain and re-allocating
the payload. For a projection rebuild over a partitioned, months-deep log (§2.1) this is the hot path,
and §16 K1's "replay rebuilds a projection byte-identically" is the operation that will run it most.
No benchmark exists.

### F17. `pathExists` returning `null` silently weakens save-time validation. NIT

`schema-introspect.ts:60-69` returns `null` for arrays, unions, records and `z.unknown()`, and
`registry.ts:68` only reports a problem on an explicit `false`. The design intent (§7) is that bad
references cannot be saved; the implementation's intent (`schema-introspect.ts:57-58`: "so the
validator only reports problems it is sure about") is that unclear cases pass. Those are different
products, and the doc does not say which one is wanted. As shipped, the default node set makes the
permissive branch the common case.

### F18. `boardProjection` drops `task.moved.v1`'s upcast target. NIT

`fixtures.ts:44` subscribes to `task.moved.v1` and `task.moved.v2`; `apply` (`:65`) branches only on
`task.moved.v2`. This works because `#hydrate` upcasts before delivery, which means the `types` filter
and the `apply` switch are written against two different vocabularies (pre- and post-upcast). The
filter is applied in SQL against the stored type (`log.ts:132`) and the switch against the upcast type:
a projection author who lists only `task.moved.v2` in `types` silently loses all v1 history. Nothing
documents this and no test covers it.

### F19. `Decision` logging is opt-in and unused. NIT

`Authz` logs through `onDecision` (`authz.ts:96`) which `createKernel` wires only if the caller passes
it (`kernel.ts:33, 60`); no production caller does. §2.3 says decisions are "logged" and §2.1 says
audit is the event log — a denial currently reaches neither.

---

## 3. Structural gaps

### S1. No rollback or failure-containment story for provisioning. BLOCKER

`compileProvisioning` builds a strictly linear chain: acquire → repos → compose → seeds → setup →
start → verify → bundles (`compile.ts:140-226`). If `verify` fails at the end, the design says nothing
and the code does nothing: the sandbox stays allocated in `HostPool`, the restored production dump
stays in the database, the compose stack stays running, and the flow run fails. There is no
compensation (D5), no `destroy` on failure, no partial-failure state in the doc's §5 lifecycle, and no
owner for the orphan. The one acceptance-style guard is `guards: { maxSteps, maxWallClockMs }`
(`compile.ts:415`) — which bounds duration, not cleanup.

### S2. No migration or data-evolution plan. MAJOR

Beyond F13's missing runner: §2.1 promises event-type versioning with upcasters (which exists,
`registry.ts:51-63`) and says nothing about the relational side. §15 lists fourteen tables, of which
`migrations.ts` creates seven, with different columns (D6). There is no statement of how an existing
deployment moves from the current `flow_runs` to the §15 `flow_runs`, how `events` becomes partitioned
once it holds rows, or what happens to in-flight runs across a deploy. §7 says "Migrating in-flight
runs is explicitly unsupported" — with no versioning (D6) there is no way to even detect that a run is
mid-migration.

### S3. No operational ownership, SLO or on-call surface. MAJOR

§16 K14 lists "OTel dashboards" as a line item; §3 hard rule 5 requires every plugin call to carry an
`otel` span. There is no tracing, no metric, no structured logger and no health endpoint in any
reviewed package — `NodeCtx` in §7 declares `logger: Logger` and the implemented `NodeCtx`
(`flow/src/types.ts:51-59`) drops it. Nothing in the doc says who owns the step runtime at 3am, what
the alert is when `recoverable()` is non-empty (nothing calls it), when the outbox DLQ grows (nothing
alerts), or when a projection falls behind (no lag metric — `projection_checkpoints` stores
`last_event_id` and `updated_at` and nobody reads the latter).

### S4. Partial failure is undefined at three boundaries. MAJOR

(a) Event appended, outbox row written, delivery dead-lettered: §10 promises "manual replay from the
log" and no code or runbook provides it (D20). (b) Sandbox created, enrollment never completes:
`IncusDriver.create` releases the pool allocation on launch failure (`incus.ts:122-125`) but nothing
handles a VM that launches and never enrolls — `state()` returns "running" and the project waits
forever. (c) Warm pool refill fails mid-loop: `refillWarmPool` (`scheduler.ts:45-55`) has no
try/catch, so a partially filled pool throws out of the caller and the already-booted warm sandboxes
are tracked only in the lost in-memory array (D12).

### S5. No production observability for the thing the design is about. MAJOR

§17.6: "Instrument cost per project per day **from K2, not at K12**." Nothing in `compute`,
`sandbox` or `flow` records cost: `Placement.costMicrosPerHour` is set to `0` by both drivers
(`local.ts:54`, `incus.ts:108`) and is used only to sort candidates (`scheduler.ts:73`); `flow_runs`
has no `cost_micros` (D6); `ctx.budget` is per-execute memory (F1). The doc's §17.6 risk is therefore
realised exactly as written.

### S6. No statement of what the kernel's compatibility promise is. MAJOR

§3 declares Tier 0 "Not extensible. Versioned API consumed by everyone else" and gives plugins an
`apiVersion: "^1.2"` range with a loader that "refuses an incompatible `apiVersion`". No package
exports a host API version; nothing in `packages/kernel` carries a version constant; `package.json`
versions were not consulted by any loader in the reviewed code. "Frozen kernel" is the load-bearing
claim of §3 and §17.1, and there is no mechanism that would detect it thawing.

### S7. Doc contradicts itself on session isolation. NIT

§13.2 states the requirement as settled ("separate uid or mount namespace per session, not just
separate directories"). §18.2 lists the same thing as an open question ("Session isolation level
inside a sandbox: separate uid, or full user namespace per session?"). A reader cannot tell whether
D17 is unimplemented work or an undecided design. Pick one.

---

## Verified: checked and holding

- `maxSessionsFor` (`sandbox/src/sessions.ts:43-52`) implements §5.4's formula exactly: 768 MiB reserve (0.75 GiB), `min(byMem, vCPU*2, driverMax)`, floored at 0.
- Gapless per-stream `seq`: the `insert … on conflict do update … returning (next_seq - 1)` upsert (`log.ts:76-81`) takes a row lock and runs in the same transaction as the event insert, so a rolled-back append leaves no gap.
- Envelope encryption is real: a fresh 32-byte data key per record, AES-256-GCM, wrapped by the master key (`secrets.ts:57-68`); `rawRow` proves no plaintext at rest, and `put` of the same value twice produces different ciphertext.
- `createKernel` refuses to boot without an explicit `keyWrapper` or `ephemeralSecrets` (`kernel.ts:41-50`) — the silent-data-loss default is correctly closed.
- `shellQuote` (`compile.ts:221-223`) is correct POSIX single-quote escaping, and `interpolateShell` applies it to every substitution on the setup-script path.
- `HostPool.allocate` re-checks `fits()` before recording (`host-pool.ts:90`), so the `plan` → `create` TOCTOU window ends in a refusal, not an overcommit, within one process.
- `filterCapable` ranks by cost then `bootP50Ms` as §4 specifies (`scheduler.ts:72-76`) and returns a per-driver rejection reason (`driver.ts:101-114`) suitable for the UI message §4 asks for.
- Upcaster chain walks with cycle detection (`registry.ts:51-63`), and superseded types are write-blocked (`registry.ts:45`).
- `KernelError.retryable` is honoured: deterministic errors end the run without burning attempts (`steps.ts:290-291`), and `GraphInvalid` / `StepInputInvalid` / `GuardTripped` / `AmbiguousStep` all correctly declare `retryable: false`.
- `SuspendRun` is distinguished from failure at both the step (`steps.ts:259-260`) and run (`steps.ts:280-286`) level.
- Blueprint semantic validation does what it claims: seed-kind/dataKind matching, dependency cycles, duplicate host ports, unresolvable `${input.X}` references, missing primary port, empty `verify` (`validate.ts:68-158`).
- Graph validation rejects unguarded cycles (`registry.ts:98-110`), self-references, unreachable nodes and unknown edge endpoints.
- `mapNode` gives each item its own memoised step key including the iteration (`nodes.ts:81`), so fan-out survives resume without re-running completed items.
- Projection checkpoint advances inside the same transaction as the applied batch (`projections.ts:69-75`) — a crash mid-batch replays rather than skips (the skip risk in D3 is from id ordering, not from this).
- `LocalProcessDriver` labels itself `isolation: "host"` rather than overstating (`local.ts:35`), which is what makes D11 a wiring failure rather than a dishonest driver.
