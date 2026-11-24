# Stage 5 — Initial Zoom Out Review

Target: `/home/user/agentmvp/docs/ARCHITECTURE.md` (Harness Cloud — Architecture v2)
Cross-read: `/home/user/agentmvp/docs/STATUS.md`, `/home/user/agentmvp/README.md`, `/home/user/agentmvp/docs/BUILD_PROMPT_v1.md`

Reviewer has no conversation history. Every finding is anchored to a line or section.

Counts: **6 BLOCKER · 16 MAJOR · 1 NIT** (23 findings). Section 4 alternatives are ungraded.

---

## 1. False compromise detection

### FC-1 — The kernel is declared unswappable and then three of its five members are made extension points — BLOCKER

§2 heading, line 54: `## 2. The kernel (NOT pluggable — this is the part that must never move)` and line 56: "Five things. If any of these are swappable you do not have a platform, you have a framework."

§3 Tier 1 table, line 149: `| auth.provider, secrets.backend, storage.backend | kernel-adjacent | oidc/saml, vault/kms/age, s3/fs |`

§2.3 is Identity and authz. §2.4 is Secrets. Both are kernel by line 54 and both appear in the Tier-1 extension table by line 149. The word "kernel-adjacent" is doing all of the work and is defined nowhere in the document. The v1→v2 table set this up at line 19: `"swappable" components → everything plug-and-play and extendable → Needs a *frozen kernel* and typed extension points, or it collapses`. The document presents frozen-kernel-plus-typed-tiers as having dissolved the extensibility/coherence tension. It has not; it has relabelled the overlap.

The tradeoff actually made: the trust root is pluggable. Line 120–121 states "Plugins never receive raw secrets unless their manifest declared that exact secret scope" — that invariant is vacuous when a plugin *is* `secrets.backend` and sits below the "fixed interface" of §2.4. Same for `auth.provider` under §2.3's "Every API handler, WS upgrade, MCP tool, flow node and plugin call goes through it."

Who pays: the security model and the operator. §3's hard rule 1 ("Plugins get a `PlatformAPI` facade, never the DB handle") cannot hold for a storage backend. §18.6 asks who may install plugins and recommends "in-process Tier 1 = superadmin" — which concedes that these three are not really tier-1-shaped, without saying so.

### FC-2 — The Temporal escape hatch is foreclosed by the kernel's own transactional requirement — BLOCKER

§2.2, lines 102–104: "if flows become the primary product, this layer is replaceable by Temporal or Restate. Keep the `step()`/`FlowNode` contract free of Postgres specifics so that port is a week, not a rewrite."

§2.1, line 59: "Every state change in the system is an event, appended **in the same transaction as the write it describes**."
§10, lines 368–369: "Subscribers on the event log write to a **transactional outbox** in the same transaction as the event."

Temporal and Restate run their history outside your Postgres transaction. The moment a `step()` commits a business write, an event and an outbox row in one transaction, the runtime is Postgres-specific by construction — that *is* the Postgres specific the escape hatch asks you to avoid. You cannot have both the single-transaction guarantee (which §2.1 says buys audit, chat history, board state, recovery, outbox and debugging "for free") and a runtime whose durability lives elsewhere.

The tradeoff actually made: build-not-buy, permanently, for the component §17.3 itself names as "harder than they look." The "week, not a rewrite" line converts a locked-in decision into an apparently reversible one.

Who pays: whoever makes decision §18.4 ("build on `pg-boss` with our own checkpointing (recommended for v1), or adopt Temporal now?") believing the option stays open. It does not stay open past K1.

### FC-3 — §5.3 presents an unmade decision under a heading that claims it is made — MAJOR

Heading, line 240: `**5.3 Ports — per-session ranges.**` Body, lines 243–244: "Two sessions can both run a dev server on :5173 inside their own netns, or get remapped — decide once, document it, and surface the real URL in the UI."

Per-session network namespaces and per-session port ranges are two different designs with different consequences. Line 241 ("sandboxd allocates a range per session") presumes remapping; line 243 offers netns as an equal alternative. §5 is introduced at line 226 as "Four conflicts to solve"; this one is listed as solved and is not.

The tradeoff actually made: deferred to implementation. With netns, a session's dev server works on the port the agent and the project's own config expect, and sandboxd needs a per-session network stack plus a proxy to reach it. With remapping, sandboxd stays simple and every tool that writes an absolute URL (Vite HMR, OAuth callbacks, Next.js `assetPrefix`) breaks for the agent in ways the agent cannot see.

Who pays: K3, whose acceptance criterion (line 488) is "4 concurrent sessions on a 4 GiB VM ... each with its own preview URL" — satisfiable by either design, so the test will not force the decision either.

### FC-4 — "Capability negotiation, not lowest common denominator" hides a product-matrix cost — MAJOR

§4, lines 213–216: "**Capability negotiation, not lowest common denominator.** ... A feature that needs snapshots is simply unavailable (with a clear reason in the UI) on a driver that lacks them — never silently degraded."

Presented as escaping the portability/capability tradeoff. It does not escape it; it moves it from runtime into the feature surface. Every feature now has an availability predicate, every UI affordance needs an absent state with an explanation, and the test matrix multiplies by the driver list at line 209–211 (six drivers planned).

Note also line 210–211: `oci` is "(fast dev/CI mode, `isolation: "container"`, blocked by policy for untrusted tenants)". The fast path exists only for tenants you already trust. That is two products — a trusted-tenant fast product and an untrusted-tenant slow one — stated as one driver choice.

Who pays: feature developers (N implementations of "is this available here"), and self-hosters on the single-box `incus-local` default who discover which features their install does not have one UI message at a time.

### FC-5 — "One UI, capability-driven" is presented as strictly better than the split it replaces — MAJOR

§12, lines 414–415: "User-vs-admin is **capability-driven rendering of one UI**, not two apps. A member without `terminal` simply does not see the tab. This replaces v1's hard user/admin app split, which does not survive 'devs need a terminal'."

The stated problem (devs need a terminal) is solved by granting the terminal capability in the user app. It does not require merging the admin console into it. v1 §9.6 required "A separate domain, scoped short-lived cookies, never console cookies. A strict CSP on the console" — merging puts admin surfaces behind the same origin and the same session as the surface that renders agent output and preview content.

The tradeoff actually made: one authz bug or one XSS now reaches plugin install (§3), secret references (§2.4), grants and budgets, instead of reaching a user app. The document asserts the merge and never states the cost.

Who pays: security review at K14, and §13 — which enumerates "Security deltas from v1" and does not list this one.

---

## 2. Load-bearing assumptions never stated or justified

### A-1 — Postgres can carry log + projections + queue + outbox + token-level deltas at the stated concurrency — BLOCKER

§2.1 line 66 names `"session.text.delta"` as an event type; §6 correction 1 (line 267) says `HarnessEvent` "is persisted to the event log, so it needs log fields." §2.2 puts the job queue in the same Postgres (`pg-boss` or `graphile-worker`). §10 puts the outbox there. §15 line 460 partitions `events` by month. §2.1 line 89 adds hot/cold tiering.

Unstated: that one Postgres absorbs per-token durable inserts for 50 concurrent sessions (K14, line 499) while the same instance is being polled by the job runtime and drained by the outbox worker.

If false: the component declared unswappable (§2) is the bottleneck, and the obvious fix — stop persisting deltas — breaks "Chat history = `stream = session:<id>`" (line 80) and K1's "Replay rebuilds a projection byte-identically" (line 486).

### A-2 — A gapless per-stream sequence is cheap to produce — MAJOR

§2.1 line 65: `seq: bigint; // per-stream, gapless`.

Gapless (not merely monotonic) requires serializing every append per stream inside the business transaction — an advisory lock or `SELECT ... FOR UPDATE` on a stream row. Never stated, never costed. The hottest stream is `project:<id>` (line 64), which every session, flow run and board change in a project writes to.

If false: writes across all of a project's concurrent sessions serialize behind one lock, which directly attacks §1's density premise (line 46).

### A-3 — Everything worth auditing happens inside a Postgres transaction — MAJOR

§2.1 line 59: "appended in the same transaction as the write it describes."

The state changes in §4 and §5 — VM created, worktree pruned, cgroup scope started, port range allocated — happen on a remote machine, reported back over the §2.5 outbound WebSocket. There is no shared transaction with Incus or with sandboxd. The document never says the invariant has an exception.

If false (it is false for the compute layer): "Audit = the log" (line 78) has holes exactly where the tenancy boundary is, and reconciliation between driver reality and log belief is an unspecified subsystem.

### A-4 — A shared bare clone is compatible with a per-session tenancy boundary — MAJOR

§5.1 line 229: "One bare clone per repo at `/srv/git/<repo>.git`." Line 231: "Sessions therefore cannot corrupt each other's files."
§13.2 lines 425–427: "Session A must not read session B's worktree: separate uid or mount namespace per session, not just separate directories. ... it is a real tenancy boundary now."

A worktree reaches its shared object store by path. Any session that can read `/srv/git/<repo>.git` can read every other session's branch objects; any session that can write it can rewrite them. Separate uids make the shared object store either unwritable or group-writable by all sessions. The document asserts both the shared store (for speed, line 231: "`git` stays fast (one object store)") and the boundary, and never reconciles them.

If false: §13.2's "real tenancy boundary" does not exist, and §18.2 ("separate uid, or full user namespace per session?") is being asked without the information needed to answer it.

### A-5 — One `perSessionMemGiB` constant describes sessions, and disk is never binding — MAJOR

§5.4 line 247: `maxSessions = min(floor((memGiB - 0.75) / perSessionMemGiB), vCPU * 2)`.

Assumptions baked into that line and never stated: sessions are homogeneous; 0.75 GiB covers sandboxd, the bare clones, page cache and the control agent; disk is not a constraint (N worktrees of a monorepo is the obvious exhaustion path and does not appear in the formula); and nested Docker memory (`nested: boolean`, line 193) is attributable to a session's cgroup scope.

v1 §12 lesson 2 is "1 GiB VMs got the agent OOM-killed **once Docker was running**." The formula has no Docker term, and line 249 cites that exact lesson as the thing it prevents.

If false: the v1 failure returns with an arithmetic blessing on it.

### A-6 — Agent-authored flows are the only agent path to privileged flow execution — BLOCKER

§13.4 lines 428–431: "a prompt-injected agent that can *author a flow* escalates. So: authoring a flow with network/secret nodes requires an elevated capability, agent-authored flows land as drafts needing human approval."

The mitigation gates *authoring*. It does not gate *invocation*. Three invocation paths bypass it:
- §8 line 341: `board.automation` — "when task enters *In Review* → run flow `review`". An agent assigned a task (line 338: "A task may be assigned to a **human or an agent**") can move it.
- §9 line 359: "Trigger → action: start a flow run, start a session with a prompt template, call a connector egress, or emit an event." Triggers fire on event filters; agents emit events.
- §7 line 300: `session(opts): Promise<SessionHandle>` inside `NodeCtx` — an approved flow can start a session that can move a card that fires an automation.

So a prompt-injected agent does not need to author anything; it needs to reach a card or emit an event matching an already-approved privileged flow's trigger. §13 does not mention this, and §17.5 repeats only the authoring framing.

If false (i.e. if there is an unstated invocation-side check): it is not in the document, so it is not in the build.

### A-7 — A flow can get a sandbox session when it asks for one — MAJOR

§7 line 300 gives `ctx.session()`. §5.4 line 248 says sessions beyond `maxSessions` "queue with a visible 'waiting for capacity' state."

The guards specified at line 316 are `maxIterations`, `maxCostUsd`, `maxWallClockMs` and a stall detector — all loop guards. There is no acquisition timeout, no admission deadline, and no statement of what a durable step does while blocked.

If false (saturated sandbox, which §5 says is the normal steady state): flow runs occupy step-runtime workers indefinitely, and the queue that was supposed to be a UI state becomes a distributed deadlock between §5.4 and §2.2.

### A-8 — Shared-sandbox and warm-pool compute can be attributed to a payer — MAJOR

§3 rule 5 (line 180): "Every plugin call is traced and **billed to the calling tenant**." §17.6 (lines 519–520): "One VM per project with warm pools is expensive; multi-session density is what makes it viable. Instrument cost per project per day from K2."

One VM per project makes per-project cost legible. The document then puts N sessions on it (§1 line 46) and a warm pool of unassigned VMs in front of it (§4 line 220), and never says how a session's share of a shared VM, or an idle warm VM belonging to nobody, is priced. §15's `flow_runs(... cost_micros)` tracks model spend only.

If false: the economics claim in §17.6 cannot be measured, and the K2 instrumentation requirement has no defined unit.

### A-9 — All event-schema evolution is expressible as read-time upcasting — MAJOR

§2.1 lines 87–88: "Event types are versioned (`task.moved.v2`) and upcasters translate old events on read — you will need this within six months."

Upcasting works only when the old event contains enough information to synthesize the new shape. Adding a field that old events never captured requires backfill, which an append-only log forbids. The document commits to the mechanism and never states its limit.

If false: the first non-additive schema change forces either a compensating-event convention or a log rewrite, both of which break "Append-only, already immutable" (line 78).

### A-10 — Replay survives retention tiering — MAJOR

§2.1 line 89: "Retention: hot in Postgres, cold tiered to object storage after N days, with the projections kept warm."
K1 acceptance, line 486: "Replay rebuilds a projection byte-identically."

Keeping projections warm is not the same as being able to rebuild them. After tiering, a rebuild must read cold storage (unspecified: format, ordering, how gapless `seq` is verified across the boundary) or start from a projection snapshot (never mentioned anywhere in the document, and absent from §15's DDL).

If false: audit and recovery guarantees silently expire at N days, and K1's acceptance test only ever runs against a log younger than N.

---

## 3. Scope coherence

### S-1 — The second-largest shipped package is absent from the architecture entirely — BLOCKER

`STATUS.md` line 19: `| — | **Blueprints**: schema, validator, compiler, catalog, AI synthesis | @harness/blueprints | 36 | **done** |`
`README.md` line 23: `packages/blueprints pre-baked environments; catalog and AI-synthesised stacks, one pipeline`

The string "blueprint" does not occur anywhere in `ARCHITECTURE.md`. A subsystem with 36 tests (second only to the kernel's 60), marked done, carrying an **AI synthesis** step that generates environment definitions, has: no section, no extension point in the §3 Tier-1 table, no row in §15's data model, no milestone in §16, and no entry in §13's security deltas despite being an LLM-authored-artifact pipeline.

Note the milestone column for that row is `—`. The build has a subsystem the design does not know exists. Either the document's scope is wrong or the package is.

### S-2 — "v1 §9 still applies in full" is false, and the clause it contradicts is the one §5 destroys — BLOCKER

§13 line 421: "v1 §9 still applies in full. New surface introduced by this design:"

`BUILD_PROMPT_v1.md` §9.1: "**Isolation.** One project = one VM (or one dedicated BYO host). The harness runs as root inside the VM, and **the VM is the boundary**."

§1 line 46 and all of §5 replace that with many mutually-untrusted sessions inside one VM where the harness runs as root. v1 §9.1 does not apply at all, let alone in full. §13.2 half-notices ("it is a real tenancy boundary now") without retracting line 421.

A reader given this document and v1 will build to a security baseline that the design has already invalidated.

### S-3 — §12 cites evidence that does not exist in the document — MAJOR

Heading line 401: `## 12. UI implications (answering the screenshot)`. Line 403: "The Claude Code shell you showed is the right *skeleton*, wrong *content* (see the five flaws noted earlier)."

There is no screenshot in the document and no list of five flaws anywhere earlier in it. The entire §12 rationale is unreviewable by anyone who was not in the originating conversation — which is every future reader, every new hire, and the implementer at K5. §12 is also the source of the user/admin merge (FC-5), a security-relevant decision whose justification is off-document.

### S-4 — The specified harness is not the built harness, and the document was not updated — MAJOR

§6 correction 4, line 271: "**One harness for v1** (pi). The adapter interface exists; the other three are Tier-1 plugins shipped later."
§16 K5, line 490: "| **K5** | **pi adapter**, normalized events into the log, chat + preview UI |"

`STATUS.md` line 20: "K5 | **Harness adapters**: normalized events + Claude Code | ... **partial** (Claude Code only)". `README.md` line 24: "normalized harness events, Claude Code adapter".

The sole harness named in the design is the one not built; the one built is named in the design only as a deferred Tier-1 plugin. Either the v1-harness decision changed (and §6.4 and K5 are stale) or the build went off-spec. The document gives no way to tell.

### S-5 — §16's build order is asserted as a sequential contract and is not being followed — MAJOR

§16 line 481: "Each milestone ends with its acceptance tests green." §17.2 line 513: "Do not start K9 before K7 works." Line 501: "Note the inversion from v1: **the kernel (K1) comes before compute.**"

`STATUS.md` line 46: "**Auth, SSO, sessions (K0)** | Not started". K1, K7, K8, K9, K10 and K12 are marked done. K0 — the first milestone, containing auth and workspaces, on which §2.3's "Every API handler ... goes through it" depends — has not started.

The document specifies ordering in detail and the ordering is not load-bearing in practice. Either §16 is a wish-list presented as a plan, or the build has accrued an unstated dependency inversion (an authz layer with no authenticated subjects behind it; `STATUS.md` line 46 concedes exactly this: "`authz` (the capability layer that sits above it) is complete").

### S-6 — §18's "decisions needed before K2" were resolved by building, not deciding — MAJOR

§18 line 525: "## 18. Decisions needed before K2". Items include #2 (session isolation level), #4 (pg-boss vs Temporal), #5 (own the task entity vs integrate Jira), #6 (who may install plugins).

Three of those are already decided in the body: §2.2 line 98 specifies `pg-boss`/`graphile-worker`; §13.2 line 426 commits to "separate uid or mount namespace"; §8 line 344 commits to "Core owns the task entity." And `STATUS.md` marks K7 (flow runtime), K9 (board) and K10 (plugins) as done — all downstream of decisions nominally still open and nominally gated on K2.

A section that lists settled questions as open, after the code answering them has shipped, misleads the next reader about what is still negotiable.

### S-7 — Specification altitude is inverted relative to the stated scope and the stated risk — MAJOR

Line 3 scopes the document: "Supersedes **the object model, extension model and build order**."

Against that scope: §15 gives column-level DDL for 13 tables, and §12 specifies rail-by-rail UI contents — neither is object model, extension model or build order. Meanwhile the components §17.6 names as the economic risk get the least: the model gateway is one paragraph (line 274), bundles appear only as a line in the §1 tree and a Tier-1 mention, and K4's acceptance (line 489) says "bounded overspend documented and measured" with no bound, no measurement method, and no mechanism anywhere in the document for how a streaming session is cut off mid-generation when a budget is hit.

### S-8 — "v1" is overloaded and the milestone namespaces are mixed — NIT

Line 3 and line 421 use "v1" to mean `BUILD_PROMPT_v1.md`. Line 271 ("One harness for v1") and line 530 ("recommended for v1") use "v1" to mean the first product release. v1's milestones are M0–M10; v2's are K0–K14; `STATUS.md` line 45 writes "BYO SSH hosts (**K9 in v1**)" — v1 has no K9, it has M9. Minor, but it is the kind of ambiguity that makes "v1 §9 still applies in full" (S-2) hard to even check.

---

## 4. Inventive catalyst — alternatives not weighed

### Alt-1 — One ephemeral microVM per session over a shared persistent worktree store, instead of N sessions inside one project VM

**Why better:** it deletes §5 — the section line 226 calls the one "where the design earns or loses" — along with §13.2's new tenancy boundary, §5.4's admission arithmetic (A-5) and §5.3's undecided port model (FC-3); the isolation boundary returns to the hypervisor, so v1 §9.1 would once again be true (S-2) and `firecracker` becomes the primary driver rather than a K13 afterthought.

**Why worse:** it destroys the density that §17.6 says makes the economics viable, replaces a shared bare clone with a network-attached or re-cloned repo per session (slower, and git over network storage is its own class of problem), and makes `ctx.session()` a provisioning operation rather than a process spawn.

The document commits to the opposite at line 46 ("This is the density decision") and never states the alternative it rejected.

### Alt-2 — Adopt a durable execution engine as the kernel from day one; make the event log a projection of its history, not the other way round

**Why better:** it removes the thing §17.3 admits is "harder than they look" and that §2.2 is proposing to hand-roll on `pg-boss`, turning K1 from invention into integration — and it resolves FC-2 honestly rather than claiming a one-week port later.

**Why worse:** you lose the single-transaction event-plus-write invariant (line 59) from which §2.1 derives audit, chat history, board state, recovery and outbox "for free", and you add a heavyweight operational dependency to a product whose default install is a single box (§4 line 209, `incus-local`, "the default single-box install").

§18.4 frames this as pg-boss-vs-Temporal at the *flow* layer. The unconsidered version is making it the *kernel* layer and deriving the log from it.

### Alt-3 — Conventional mutable schema plus Postgres logical decoding (CDC) for audit, outbox and subscriptions, instead of hand-built event sourcing

**Why better:** the WAL gives you the "same transaction as the write" guarantee natively, with no hand-written gapless `seq` (A-2), no schema registry at boot, no upcasters (A-9), and no bespoke cold-tier replay path (A-10); the outbox pattern in §10 becomes a standard CDC sink rather than a table you drain yourself.

**Why worse:** CDC events are row-shaped, not domain-shaped, so `causationId`/`correlationId` (lines 72–73) and the board's semantic projections must be re-derived or carried separately, and you permanently lose the ability to replay intent the rows never recorded — "`causationId` chains answer 'why did this happen' in one query" (line 83) is precisely the thing CDC does not give you.

The document asserts event sourcing at line 22–25 ("The single idea that makes all of this one system instead of six") without naming a single alternative that also produces audit, outbox and subscriptions from one write path.
