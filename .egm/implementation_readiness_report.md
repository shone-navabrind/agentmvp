# Stage 9 — Implementation Readiness Test

**Question answered:** could a competent engineer who has never seen this project pick up the plan
and build the next milestone without asking the author questions?

**Verdict: no.** The next unbuilt milestone in dependency order (K3, sandboxd + multi-session) sits
behind a wire contract that the architecture declares to be kernel, that STATUS.md calls "specified",
and that is in fact five lines of prose with no method signatures. Four other milestones (K5, K6, K13,
K14) sit behind the same gap.

**Method:** read `docs/ARCHITECTURE.md` (§1–§18), `docs/STATUS.md`, `docs/BUILD_PROMPT_v1.md`,
`README.md`; enumerated `packages/` and `apps/` exports; read `packages/kernel/src/migrations.ts`,
`packages/kernel/src/registry.ts`, `packages/plugins/src/host.ts`, `packages/compute/src/scheduler.ts`,
`packages/compute/src/drivers/incus.ts`, `packages/sandbox/src/sessions.ts`, `packages/flow/src/nodes.ts`,
`packages/flow/src/runner.ts`, `packages/billing/src/ledger.ts`, `apps/api/src/demo-data.ts`,
`apps/api/src/server.ts`; ran `npm test` to completion.

**Findings: 8 BLOCKER · 36 MAJOR · 5 NIT (49 total).**

---

## 1. Readiness per milestone

Milestones not marked built in `docs/STATUS.md` → "What is built and tested" / "What is NOT built":
K0, K4, K6, K11, K13, K14 (unstarted); K3 and K5 (partial). K2, K7–K10 and K12 are claimed built and
are re-assessed in §3.

### K0 — Monorepo, CI, Compose, auth, workspaces, authz registry — **UNDERSPECIFIED**

**F1 · BLOCKER · K0, ARCHITECTURE §16 row K0**
K0 bundles five deliverables and specifies one. The implementer must invent, with no guidance in any
document: (a) the session mechanism — cookie, JWT or bearer; (b) whether local password auth exists at
all in v2 (§3 lists `auth.provider` with examples "oidc/saml"; `BUILD_PROMPT_v1.md` §10 M1 instead
specifies `ADMIN_EMAIL`/`ADMIN_PASSWORD` bootstrap, and nothing says which survives); (c) the CI
provider; (d) the Compose topology for v2 (v1 §10 M0 names Postgres, LiteLLM + its Postgres, API, web —
v2 added workers, plugin containers and an MCP surface and never restated it). On disk: no `.github/`,
no `Dockerfile`, no `docker-compose.yml`, no auth code anywhere (`grep` for login/oidc/cookie/bearer
across `packages` and `apps` matches only `apps/api/src/demo-data.ts` and `integration.test.ts`).

**F2 · MAJOR · K0, ARCHITECTURE §15 vs §1**
§1 says "Workspace … members, budget pool, policy, plugin set" but §15's table list has
`workspaces(id, tenant_id, name, settings)` and no membership table. §15 defers to "everything from v1 §8
(users, orgs→workspaces, grants …)" — a rename of one entity across two documents, with the join table
in neither. Membership shape, invite flow and role-vs-grant precedence must be invented.

### K3 — sandboxd + multi-session — **BLOCKED**

**F3 · BLOCKER · K3, ARCHITECTURE §2.5 (and §5, v1 §4.3)**
§2.5 is the whole specification of the sandbox protocol: "outbound mTLS WebSocket, JSON-RPC. Versioned."
§5 adds bare method names (`session.create/prompt/abort/attach/detach`, `pty.open{sessionId}`,
`fs.*{sessionId}`, `ports.list{sessionId}`). v1 §4.3 adds a one-line-per-method table. Across all three
there is no parameter shape, no result shape, no error taxonomy, no stream framing, no backpressure rule,
no version-negotiation behaviour, and no definition of the enrollment-token → mTLS-certificate exchange
(endpoint, token TTL, CSR format, revocation). §2.5's own text says "Changing it is a breaking change for
every deployed sandbox, so it is kernel" — a contract with that property cannot be left to the first
implementer. `STATUS.md` → "What is NOT built" states "The sandbox protocol is specified in
`ARCHITECTURE.md` §2.5". It is named there, not specified. Nothing in `packages/` implements or types it;
`grep -i "jsonrpc\|mtls\|sandboxd"` across `packages`/`apps` returns only comments.

**F4 · BLOCKER · K3, ARCHITECTURE §13.2 and §18 decision 2**
Session isolation level is an open decision ("separate uid, or full user namespace per session?") that
§13.2 orders be made explicitly: "separate uid or mount namespace per session, **not just separate
directories**. Decide and test this explicitly — it is a real tenancy boundary now."
`packages/sandbox/src/sessions.ts` implements exactly what §13.2 rules out: a per-session directory plus a
systemd scope name (`hc-session-${id}.scope`, line 126). No `uid`, `chown`, `unshare` or namespace call
appears in `sessions.ts` or `worktrees.ts`. The implementer must pick the tenancy model, and the choice
changes the baked image (per-session users must be provisioned at build time) — i.e. it reaches backwards
into K2, which is marked done.

**F5 · MAJOR · K3, ARCHITECTURE §5.3 vs v1 §4.4**
§5.3 states the port-collision choice and leaves it open: "Two sessions can both run a dev server on :5173
inside their own netns, or get remapped — decide once, document it". Undecided. Worse, the two documents
give different preview URL shapes: §5.3 says `<port>--<sessionId>.preview.<domain>`, v1 §4.4 says
`<port>--<projectId>.preview.<domain>` and scopes the signed preview cookie to the project. Moving the
subdomain to the session changes the cookie scope and the proxy's lookup key, and no document says which
form wins.

**F6 · MAJOR · K3, ARCHITECTURE §5.4**
Admission control is given as `maxSessions = min(floor((memGiB - 0.75) / perSessionMemGiB), vCPU * 2)` and
`perSessionMemGiB` is never assigned a value anywhere in either document. The acceptance case ("4
concurrent sessions on a 4 GiB VM") only holds for `perSessionMemGiB <= 0.8125`; the implementer must
back-solve the constant from the acceptance test.

### K4 — Gateway, project keys, budgets — **UNDERSPECIFIED**

**F7 · MAJOR · K4, ARCHITECTURE §16 row K4**
"bounded overspend documented and measured" names no bound. v1 §7.4 asserts "no race window where the
platform overspends by more than one in-flight request" but gives no figure, no measurement window and no
method. The implementer must choose the number that the milestone is graded against.

### K5 — pi adapter, normalized events, chat + preview UI — **BLOCKED**

**F8 · BLOCKER · K5, ARCHITECTURE §16 row K5 and §6.4**
K5's named deliverable is the **pi** adapter; §6.4 is explicit that pi is the single harness for v1 and the
other three are later Tier-1 plugins. No document in the repository identifies pi: no CLI name, no
invocation, no output format, no repository, no version, no licence, no install path into the baked image.
`BUILD_PROMPT_v1.md` §6 says "pi by default" and §6.3 refers to a harness × API-family matrix that v2 §6.4
then deletes as "a maintenance liability". An implementer cannot write this adapter; they cannot even
obtain the binary.

**F9 · MAJOR · K5, ARCHITECTURE §6 correction 3**
`tool.output` is specified as "(truncated, with a pointer to full output in object storage)". No
`storage.backend` is chosen, no bucket or path convention is given, and no truncation threshold is stated.
The same gap blocks §2.1's cold tiering, where the retention period is written literally as "after N days".

**F10 · MAJOR · K5, ARCHITECTURE §16 row K5, v1 §4.4**
K5's acceptance requires "preview renders". The preview proxy — separate registrable domain, signed
short-lived preview cookie, tunnel forwarding, HMR-capable WebSocket passthrough — is specified only in
v1 §4.4 and appears as a deliverable of **no** v2 milestone. It is neither in K3 (which only reports
`ports.changed`) nor in K5's deliverable list, yet K5 is graded on it.

### K6 — Multi-repo — **UNDERSPECIFIED**

**F11 · MAJOR · K6, ARCHITECTURE §11, §15**
"GitHub App installation tokens (1h) **or equivalent**" is the entire credential spec. Unstated: which
providers are supported (`repos.provider` in §15 is an untyped column with no enum), who registers the
App, where the App private key lives relative to §2.4's secret URIs, and what "refreshed by sandboxd over
the tunnel" means as an RPC method — which is blocked on F3. The acceptance phrase "two **linked** PRs"
is defined only by §11's prose "links them to the same task"; the link's representation
(`tasks.linked_pr_urls` in §8) is given but the PR-body/cross-reference convention is not.

### K11 — Integrations: outbox, connectors, REST + MCP + client — **UNDERSPECIFIED**

**F12 · MAJOR · K11, ARCHITECTURE §10, §3**
§4 gives `ComputeDriver` as a TypeScript interface. §7 gives `FlowNode` and `NodeCtx` as TypeScript
interfaces. §10 gives `connector.ingress` / `connector.egress` as two bullet points of prose and no type
at all, despite §3's table listing them as first-class Tier-1 extension points. There is no connector
interface in the codebase either. The acceptance condition "MCP client can drive a full project lifecycle"
does not enumerate the lifecycle, so there is nothing to test against. The outbox half is real
(`packages/kernel/src/outbox.ts`) but takes an injected `deliver` callback — no HTTP egress, no HMAC
signing, no timestamp/replay window, all of which §10 requires.

### K13 — More drivers and harnesses — **UNDERSPECIFIED (conditional READY)**

**F13 · NIT · K13, ARCHITECTURE §16 row K13**
The `ComputeDriver` interface and capability negotiation genuinely do make additional drivers additive, as
STATUS claims. K13 is nonetheless downstream of F3: every driver's sandbox must speak the unspecified
protocol. Readiness is conditional on K3, not on anything K13 itself leaves out.

### K14 — Hardening: tenancy, RLS, backup/restore, OTel, load — **BLOCKED**

**F14 · BLOCKER · K14, ARCHITECTURE §15, §16 row K14**
Three of the five K14 deliverables have nothing to act on.
*RLS:* §15 states tenancy is "enforced in the repository layer **and** Postgres RLS. Not 'if feasible' —
required". `packages/kernel/src/migrations.ts` creates seven tables (`streams`, `events`, `outbox`,
`projection_checkpoints`, `flow_runs`, `flow_steps`, `secrets`) and zero RLS policies. None of
`workspaces`, `projects`, `project_repos`, `repos`, `sessions`, `tasks`, `triggers`, `plugins`,
`plugin_grants`, `flows`, `flow_versions` or `compute_hosts` exist. There is no schema to secure.
*Backup/restore drill:* the only database in the system is `openMemoryDb()` (PGlite, in-process,
`apps/api/src/demo-data.ts:26`). There is no persistent instance, connection string or migration runner to
drill against.
*Load test (50 sessions × 10 projects):* requires real compute, blocked on F41.

---

## 2. Acceptance criteria — testability

The two K1 criteria ("resumes and produces identical output", "replay rebuilds a projection
byte-identically") are the only pair in §16 that are mechanically checkable and actually checked
(`packages/kernel/src/steps.test.ts:55`, `packages/kernel/src/projections.test.ts:14`). The rest:

**F15 · MAJOR · K2, §16 row K2** — "sandbox ready <10s warm, <60s cold" is not measurable in this
project as it stands, which `STATUS.md` → "What is NOT built" concedes ("No KVM or Incus in this
container"). The only boot figure in the codebase is `bootP50Ms: 18_000`, a hardcoded literal returned by
`capabilities()` in `packages/compute/src/drivers/incus.ts:95`. That is a declaration, not a measurement,
and nothing distinguishes the two to a reader of the test suite.

**F16 · MAJOR · K3, §16 row K3** — "no OOM" is unmeasurable as written: no workload, no duration, no
per-session memory ceiling (see F6). "isolated FS" names no test; §13.2 says the isolation must be tested
explicitly and §16 does not say what the test is.

**F17 · MAJOR · K4, §16 row K4** — "revoked key fails <5s" requires a running LiteLLM with real provider
credentials. `STATUS.md` states the project has neither. The criterion is untestable in CI until P5 is
satisfied, and no fallback (recorded cassette, contract double) is specified.

**F18 · MAJOR · K8, §16 row K8** — "trigger → flow → session → **PR** traceable by one `correlationId`"
terminates in an artefact produced by the `git.pr` node, a K6 deliverable. See F28 and F37.

**F19 · MAJOR · K10, §16 row K10** — "zero impact on the API" is unmeasurable. No latency budget, no
error-rate budget, no concurrency level. "Zero" is not a measurable quantity for a shared process.

**F20 · MAJOR · K12, §16 row K12** — "drift <$0.01/key/day with an alarm": "key" means a LiteLLM virtual
key (v1 §7.1), which exists only after K4. The criterion measures platform-ledger versus gateway-reported
spend. What `packages/billing/src/ledger.ts:181` implements is `reconcile()`, returning
`balanceMicros - sumMicros` — wallet balance versus the sum of its own entries. That is an internal
invariant of the ledger, not drift against an external system. See F27.

**F21 · MAJOR · K0, §16 row K0** — "role/capability matrix is table-driven and green" is testable and
covers one of K0's five deliverables. CI, Compose, auth and workspaces have no stated condition, so four
fifths of the milestone cannot be failed.

**F22 · NIT · K13, §16 row K13** — "a missing capability is **a clear UI message**, never a silent
downgrade". "Clear" is unmeasurable; the "never a silent downgrade" half is testable and should carry the
criterion alone.

**F23 · MAJOR · K14, §16 row K14** — "security suite (v1 §11)". v1 §11 defines that suite as network
policy tests plus nightly "contract tests: real harness CLIs against a real LiteLLM". Both need
infrastructure the project states it does not have, and the harness CLIs need F8 resolved first.

---

## 3. Honesty audit — `docs/STATUS.md` against disk

**F24 · BLOCKER · STATUS.md header line; README.md**
STATUS.md opens: "**239 tests, 11 packages, 0 failures**". `README.md` repeats "239 tests, 11 packages".
Running `npm test` in this working tree now:

```
tests 262   pass 261   fail 1   skipped 0
```

The failure is `apps/api/src/a11y.test.ts:81` — "no violations in any view":

```
axe-core found violations:
  [serious] color-contrast on "setup"    (104 nodes)
  [serious] color-contrast on "chat"     ( 94 nodes)
  [serious] color-contrast on "board"    ( 96 nodes)
  [serious] color-contrast on "flows"    ( 94 nodes)
  [serious] color-contrast on "triggers" (104 nodes)
  [serious] color-contrast on "repos"    (104 nodes)
  [serious] color-contrast on "terminal" ( 87 nodes)
  [serious] color-contrast on "plugins"  (104 nodes)
  [serious] color-contrast on "billing"  (105 nodes)
9 !== 0
```

Every view fails. STATUS lists the row "Full-stack integration + accessibility gate + web UI | 12 |
**done**". Commit `a6b47ab` is titled "WCAG AA pass with an enforced axe-core gate". The gate is enforced
and it is red — most likely regressed by the later redesign in `457e4dc` ("pro-tool redesign"), which also
rewrote `apps/web/public/app.css`. A status document whose first line is a test count must be regenerated,
not written by hand.

**F25 · MAJOR · K2, STATUS "What is built and tested" row K2**
K2 is marked **done**. §16 K2's deliverables are "`ComputeDriver` + `incus-local` (host splitting) +
**baked image** + warm pool". There is no image pipeline, no builder, no `provision.sh` (v1 §5.1) anywhere
in the repository. `imageVersion` exists only as a string compared for warm-pool matching
(`packages/compute/src/scheduler.ts:40-51`). One of four named deliverables is absent and the milestone is
marked done, not partial.

**F26 · MAJOR · K10, STATUS row K10**
K10 is marked **done**. §16 K10's deliverables include "**out-of-process runtime**", and §3's Tier 2 hard
rule is "An untrusted plugin never runs in the API process — that is the rule that keeps 'pluggable' from
meaning 'one bad plugin takes down the control plane'". `packages/plugins/src/host.ts` contains no
`child_process`, no `worker_threads`, no container spawn. The sole enforcement is `host.ts:126`:
`if (m.trust === "untrusted" && m.runtime === "in-process")` — a manifest rejection. Refusing to load an
untrusted plugin is not an out-of-process runtime, and it means K10's own acceptance case ("an untrusted
plugin that crashes or hangs is circuit-broken") cannot be exercised: an untrusted plugin cannot run at
all. The circuit breaker that is tested protects against in-process `core`/`verified` plugins only.

**F27 · MAJOR · K12, STATUS row K12**
K12 is marked **done** against a criterion (gateway drift) that measures a quantity the system cannot
produce. See F20. STATUS's own "What is NOT built" row for K4 confirms the dependency: "`BudgetEnforcer`
is tested against a fake that records budget pushes and spend pulls". The milestone is graded on the
fake's behaviour.

**F28 · MAJOR · K8, STATUS row K8**
K8 is marked **done**. Its acceptance chain ends in a PR. There is no git-provider code in the repository
and K6 is unbuilt. The trigger→flow→session links are real; the final hop is not.

**F29 · MAJOR · STATUS "Screenshots" table**
The table lists ten files: `01-session-chat.png`, `02-board.png`, `03-flows.png`, `04-triggers.png`,
`05-repos-worktrees.png`, `06-terminal.png`, `07-plugins.png`, `08-credits.png`, `09-second-session.png`,
`10-narrow.png`. `docs/screenshots/` contains thirteen with different numbering:
`01-setup-blueprint.png`, `02-session-chat.png`, `03-board.png`, `04-flows.png`, `05-triggers.png`,
`06-repos.png`, `07-terminal.png`, `08-plugins.png`, `09-credits.png`, `10-guided-setup.png`,
`11-guided-chat.png`, `12-guided-board.png`, `13-narrow.png`. Named files `05-repos-worktrees.png` and
`09-second-session.png` do not exist; three guided-mode captures are undocumented. Every row of the table
is wrong. The table was not updated when the UI was rebuilt in `457e4dc`.

**F30 · NIT · STATUS "What is built and tested" table**
Per-package test counts are wrong in five of eleven rows. Measured from the run: kernel **62** (claimed
60), blueprints **41** (36), flow **25** (19), api **22** across `integration.test.ts` + `a11y.test.ts` +
`journey.test.ts` (12). Correct: harness 24, compute 20, plugins 18, triggers 16, sandbox 13, billing 12,
board 9. Separately, "11 packages" counts `apps/api` as a package; `packages/` holds ten.

**F31 · MAJOR · STATUS "What is NOT built, and why" table**
The table is headed "Honest accounting. Nothing below is stubbed out and claimed as working" — and omits
two whole milestones. **K6** (multi-repo, per-session branches, short-lived tokens, PR node) appears in
neither table. **K11** (outbox-backed connectors, public REST + OpenAPI, MCP server at `/mcp`, generated
typed client) appears in neither table. Both are unbuilt: no connector interface, no MCP server, no
OpenAPI document, no generated client, no git provider code. A reader of STATUS.md cannot discover that
K6 and K11 are missing; they have to notice the gap in the numbering themselves. This is the single most
misleading property of the document.

**F32 · MAJOR · ARCHITECTURE §15 vs `packages/kernel/src/migrations.ts`**
§15 lists roughly fourteen tables and states tenancy enforcement is "required". Seven kernel tables exist;
none of the business tables do (see F14). Consequently board tasks, triggers, plugin registrations,
sessions, ledger wallets and compute hosts are held in process memory by their respective managers, not in
Postgres. STATUS does not mention this anywhere, and the "done" marks on K8, K9, K10 and K12 read as
persistence that does not exist.

**F33 · MAJOR · STATUS, final paragraph of "What is NOT built"**
"The web app is a working UI served by the API over **real data from every package**". The API's data
source is `apps/api/src/demo-data.ts` — 345 lines that boot `openMemoryDb()` and drive a scripted scenario
with hardcoded `SCOPE = { tenantId: "t1", workspaceId: "ws1", projectId: "p1" }` and
`USER = { kind: "user", id: "u-shone" }`. The packages exercised are real; the data is a fixture rebuilt
on every process start and discarded on exit. The accompanying claim under "Screenshots" — "every number
in them comes from the packages, not from fixtures in the page" — is literally true and rhetorically
misleading: the fixture moved from the page into the server.

**F34 · MAJOR · K5, STATUS row K5**
K5 is marked "**partial** (Claude Code only)". §16 K5's deliverable is the **pi** adapter and §6.4 states
pi is the one harness for v1 with the other three shipped later as Tier-1 plugins. The adapter that was
built is one of the three the milestone defers. By the milestone's own definition K5 is at zero, not
partial; the work done is unscheduled K13 scope.

**F35 · NIT · ARCHITECTURE §15 vs `packages/kernel/src/migrations.ts`**
`flow_steps` is specified as `(run_id, node_id, attempt, state, input, output, checkpoint, error)`. The
implementation is `(run_id, step_key, state, idempotent, output, error, attempt, at)` with
`primary key (run_id, step_key)`. `node_id` became `step_key`; `input` and `checkpoint` are absent; and the
primary key excludes `attempt`, so per-attempt history cannot be stored despite `attempt` being a column.
§7's "retry / skip / resume-from-step controls for admins" needs the attempt history this schema discards.

**F36 · MAJOR · `packages/blueprints/`, ARCHITECTURE §16**
`@harness/blueprints` (schema, validator, compiler, catalog, AI synthesis — 41 tests, the largest single
package by test count, plus a visible onboarding surface in the UI) corresponds to no milestone in §16.
STATUS lists it with "—" in the `#` column and marks it **done**. It was built ahead of K0, K4, K5, K6 and
K11, and no document states what it is for, who asked for it, or what its acceptance condition is.

---

## 4. Sequencing — inversions

**F37 · MAJOR · ARCHITECTURE §16 ordering vs git history**
Execution is inverted against the plan. Built and marked done: K1, K2, K7, K8, K9, K10, K12, plus
unplanned blueprints. Skipped: K0, K4, K5, K6. §17.2 warns "K1–K5 is a real product on its own; K7–K10 is
a second one. Do not start K9 before K7 works." The narrow instruction was obeyed; the broader one — finish
the first product — was not. The consequence is structural, not stylistic: K8's acceptance ends at a PR
(no K6), K12's ends at gateway drift (no K4), K5's ends at a rendered preview (no proxy), so three
"done" milestones are graded against components that do not exist and are stood in for by fakes.

**F38 · MAJOR · K2 depends on K3 — §16 rows K2 and K3, v1 §10 M2**
K2's criterion is "project → sandbox **ready** <10s warm". A sandbox is not ready until it has reported
itself ready, which is the enrollment handshake performed by sandboxd — a K3 deliverable. v1's equivalent
milestone states this plainly ("reaches `enrolled` in under 10s"); v2 dropped the word and kept the number.
K2 cannot be measured before K3 exists. This is a genuine plan-level inversion, not just an execution one.

**F39 · MAJOR · K9/K10 UI before K0 auth — §12, §16 rows K0, K9, K10**
§12 specifies "capability-driven rendering of one UI … A member without `terminal` simply does not see the
tab." Capability-driven rendering requires an authenticated subject. K0 provides the subject and is
unbuilt; K9's board and K10's admin console shipped first. What exists instead is a role toggle in the
page (`apps/api/src/journey.test.ts`: "switching to Operator reveals the machinery, same page"), i.e. the
authorization surface is currently a client-side control with no identity behind it. Whoever builds K0
must retrofit a subject into UI that was written without one.

**F40 · MAJOR · ARCHITECTURE §18**
§18 is headed "Decisions needed **before K2**" and K2 is marked done. None of the seven has a recorded
answer anywhere in the repository — there is no decision log, and STATUS does not mention them. Decision 4
(pg-boss / graphile-worker / own checkpointing / Temporal) was in fact settled in code — the runtime uses
its own Postgres leases (`flow_runs.lease_until` in `migrations.ts`) and neither pg-boss nor
graphile-worker is a dependency — contradicting §2.2's text, which names both. Decisions 1, 2, 3, 5, 6 and
7 are open, and 2 and 3 gate the next milestone (F4, P5).

---

## 5. Unstated prerequisites

**F41 · BLOCKER · K2, K3, K13, K14**
A host with KVM and Incus. Unstated: who provisions it, which Incus version the `incusArgv` construction
targets, whether the control plane runs on the same box or reaches Incus over its HTTPS API, and what
credential the control plane uses to authenticate to Incus. §4 and §16 are silent; `STATUS.md` names the
gap ("Execution needs a KVM runner") without naming the requirement.

**F42 · BLOCKER · K6, K8**
A registered git-provider identity: a GitHub App (app id, private key, installation flow, webhook secret)
or the "equivalent" §11 declines to define. Required before K6 can mint tokens and before K8's acceptance
chain can reach a PR. Nothing says who registers it or where the private key lives.

**F43 · MAJOR · K1 onward, K14**
A persistent Postgres: connection configuration, a migration runner invoked outside the test process, and
an operational home. Today `migrate()` is called in-process against PGlite and there is no
connection-string configuration anywhere. K14's restore drill and §15's RLS have nothing to run against.

**F44 · MAJOR · K5**
Two registrable domains with wildcard DNS and TLS — v1 §4.4 requires the preview domain be separate from
the console domain "so preview pages can't read console cookies". Required for K5's "preview renders" and
mentioned in no v2 milestone (see F10).

**F45 · MAJOR · K4, and any milestone that puts a sandbox on the internet**
Provider API keys, a LiteLLM deployment with its own Postgres, and an answer to §18 decision 3 (sandbox
egress: allowlist or open). The decision is not a preference: §18.3's own text is "Open + free project
creation = a mining service". That makes it a go-live gate, and it is unanswered.

**F46 · MAJOR · K0, and the acceptance of K2, K3, K13, K14**
A CI provider, and for four milestones a runner with nested virtualization. §16 K0 lists CI; v1 §10 states
"Each milestone ends with its acceptance tests green **in CI**". The repository has no pipeline of any
kind, and hosted CI generally does not offer KVM, so the acceptance criteria for K2, K3, K13 and K14 need
self-hosted runners that no document mentions.

**F47 · MAJOR · K5, §2.1**
An object storage backend, a bucket, a path convention, a truncation threshold for `tool.output`, and a
value for the retention period written as "after N days" in §2.1. `storage.backend` is listed in §3 as an
extension point with examples "s3/fs" and no default is chosen.

**F48 · NIT · K12, v1 §7.4**
A transport for the 80% / 100% budget alerts. v1 §7.4 specifies "webhook + email + banner in the UI";
`packages/billing/src/budget.ts:81-92` fires an in-process callback and there is no email or webhook path
in the repository.

**F49 · MAJOR · K2 ← K3, §13.2 / §18.2**
The answer to the session-isolation decision (F4) determines whether the baked image must provision
per-session users or namespace tooling at build time. That makes a K3-blocking decision a prerequisite for
rebuilding the K2 image, so K2 is not finishable until it is answered — which no document states.

---

## Grade tally

| Grade | Count | IDs |
|---|---|---|
| **BLOCKER** | 8 | F1, F3, F4, F8, F14, F24, F41, F42 |
| **MAJOR** | 36 | F2, F5, F6, F7, F9, F10, F11, F12, F15–F21, F23, F25–F29, F31–F34, F36–F40, F43–F47, F49 |
| **NIT** | 5 | F13, F22, F30, F35, F48 |
| **Total** | **49** | |

## Single biggest blocker to starting the next milestone

**F3** — the sandbox protocol (§2.5). It is declared kernel ("Changing it is a breaking change for every
deployed sandbox"), `STATUS.md` reports it as already specified, and it consists of five lines of prose
plus a list of method names with no parameters, results, errors, framing, version negotiation or
enrollment handshake. K3 cannot start, and K5, K6, K13 and K14 all sit behind it.
