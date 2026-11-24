# Stage 6 — Comprehension Test

Target: `/home/user/agentmvp/docs/ARCHITECTURE.md` (Harness Cloud — Architecture v2)
Reviewer: Goldfish (no prior context, read target only)

---

## 1. PARAPHRASE A — "What is this system?"

This is a hosting platform for AI coding agents, sold to organisations rather than individuals.
Customers are nested: a billing tenant contains workspaces, a workspace contains projects, and each
project is permanently bound to exactly one virtual machine. Several agent conversations can run
simultaneously on that single machine, each pinned to its own directory, its own git branch, its own
CPU and memory limit, and its own block of network ports, so one runaway agent cannot starve or
overwrite another. The platform's foundation is a write-once ledger of everything that happens, paired
with an execution engine that records each completed step so a crashed job can pick up exactly where it
stopped. Nearly every visible feature — the task board, scheduled jobs, reactions to incoming webhooks,
the audit trail, outbound notifications to Slack or Jira, and the transcript of each conversation — is
described as a different reading of that same ledger rather than an independent subsystem. Around this
fixed core sit typed plug-in slots: alternative virtualisation backends, alternative agent programs,
workflow step types, board widgets, and integrations with outside tools.

---

## 2. PARAPHRASE B — "What would I build first, and why?"

I would build the ledger and the resumable job engine before anything else, together with the login,
permission-check and secret-handling modules they depend on. The document's own ordering table puts this
first and justifies it bluntly: every later feature is cheap once this exists and effectively impossible
to bolt on afterwards. Concretely that means an append-only table of records with a per-stream counter, a
boot-time registry that validates each record's shape, derived read-models rebuilt by replaying those
records, and a wrapper that caches the result of each completed side effect keyed by job and step so a
restart replays the cached outcomes instead of re-running them. The stated proof of completion is harsh
and useful: kill a worker halfway through a job, restart, and get byte-identical output and a
byte-identical rebuilt read-model. After that I would do the virtual-machine driver and the multi-tenant
machine itself, because the density gamble — many conversations per machine — is both the cost model and,
by the document's own admission, the riskiest engineering in the design. Board, workflows and plug-ins come
much later.

---

## 3. FINDINGS

### BLOCKER

**B1 — The document is explicitly not self-contained; it outsources whole layers to a file I cannot read.**
Header, lines 3–5: "v1 remains the reference for: baked images, network policy, LiteLLM key topology, the
credits ledger, and the prototype lessons". §6 line 263: "Unchanged in shape from v1 §6 (`HarnessAdapter`,
normalized `HarnessEvent`, LiteLLM as `model.gateway`), with four corrections". §13 line 421: "v1 §9 still
applies in full." §15 line 471: "Plus everything from v1 §8". §16 K14 line 499: "security suite (v1 §11)".
The harness layer is one of the three things the product actually sells, and its contract — the thing the
four "corrections" correct — is nowhere in this document. Same for the security baseline, the data model
baseline, the image/warm-pool model and the acceptance suite. I cannot build §6, §13, §15 or K14 from this
file.

**B2 — Dangling reference to material that does not exist anywhere in the document.**
§12 line 403: "The Claude Code shell you showed is the right *skeleton*, wrong *content* (see the five
flaws noted earlier)." Nothing earlier in this document enumerates five flaws, and no screenshot is
reproduced or described. The entire §12 heading is "UI implications (answering the screenshot)". I cannot
tell what was wrong with the thing being corrected, so I cannot tell whether the proposed layout corrects
it.

**B3 — `pi` is never defined, and it is the only harness that ships.**
First use, §3 Tier-1 table line 143: "`harness.adapter` | §6 | pi, claude-code, codex, opencode". Then §6
line 271: "**One harness for v1** (pi)." Then K5 line 490: "**pi adapter**". Three of the four names are
recognisable products; `pi` is not. The single deliverable of milestone K5 is an adapter for an unnamed,
undescribed thing. Relatedly, "harness" itself is used before definition — first at §2.5 line 125, "Every
compute driver and every harness lives behind it" — and its definition is deferred to v1 (see B1).

**B4 — Direct contradiction in the plug-in data contract.**
§3 Tier 2, lines 152–153: "Run as a container or worker with a capability token and **no DB access**."
§3 hard rule 1, line 176: "Plugins get a **`PlatformAPI` facade**, never the DB handle, never the Drizzle
client." §3 hard rule 4, line 179: "Plugins own their own Postgres schema. Core tables are off limits.
Uninstall drops the schema." A plug-in cannot both own Postgres tables and have no database access and no
handle. Either the facade proxies arbitrary SQL into the plug-in's schema (unstated, and a large piece of
engineering), or rule 4 applies only to Tier 1 (unstated, and contradicted by line 158: "Manifest, identical
shape for both tiers"). I had to guess, and both guesses change the plug-in runtime substantially.

**B5 — The `step()` contract, which the document calls the basis of all recovery, is specified twice with
incompatible signatures.**
§2.2 line 96: `await ctx.step("clone-repo", { idemKey }, async () => { /* side effect */ });` — three
arguments, caller supplies an idempotency key.
§7 line 300: `step<T>(key: string, fn: () => Promise<T>): Promise<T>;   // memoized side effect` — two
arguments, no idempotency key.
§2.2 line 98 then says memoization is keyed by "`(runId, stepKey, attempt-safe idemKey)`", so the key is
load-bearing and §7's version cannot work. §2.2 line 103 also instructs me to "Keep the `step()`/`FlowNode`
contract free of Postgres specifics" — I am told to freeze a contract the document states two ways.

### MAJOR

**M1 — "Closed registry" of capabilities contradicts the capability examples.**
§2.3 line 114: "Capabilities are strings in a closed registry." §3 manifest lines 168–169:
`capabilities: Capability[];    // "events:read:project", "secret:read:workspace/jira-token",` /
`// "http:egress:api.atlassian.com", "sandbox:exec"`. A closed registry cannot enumerate every third-party
hostname or every workspace secret name. Either capabilities are structured (verb + parameterised scope)
or the registry is not closed. The lint rule in line 115 ("No ad-hoc `if (user.role === 'admin')` anywhere
— lint rule enforced") is checkable; the registry claim is not.

**M2 — "Tenant id on every row" is contradicted by the schema that follows it.**
§15 line 474: "Tenant id on every row; enforced in the repository layer **and** Postgres RLS. Not 'if
feasible' — required". The listing immediately above it, lines 455–469, omits `tenant_id` from
`project_repos`, `repos`, `sessions`, `outbox`, `flows`, `flow_versions`, `flow_runs`, `flow_steps`,
`triggers`, `plugin_grants` and `compute_hosts`. Only `events` carries it. I cannot tell whether the
listing is shorthand or whether the rule is aspirational, and RLS policies are not writable from either
reading.

**M3 — Session isolation is specified three different ways and never resolved.**
§5.3 line 243: "Two sessions can both run a dev server on :5173 inside their own **netns**".
§13.2 lines 425–426: "separate **uid or mount namespace** per session, not just separate directories."
§18.2 line 528: "Session isolation level inside a sandbox: separate **uid, or full user namespace** per
session?" Network namespace, mount namespace and user namespace are three different mechanisms with three
different consequences for ports, for filesystem visibility and for the cgroup scheme in §5.2. §5.3 line
244 then says "decide once, document it" — the document declines to do either. K3's acceptance test (line
488, "isolated FS") is therefore untestable: I do not know what isolation I am asserting.

**M4 — The admission-control formula contains an undefined variable, and the acceptance test contradicts
the sizing elsewhere.**
§5.4 line 247: `maxSessions = min(floor((memGiB - 0.75) / perSessionMemGiB), vCPU * 2)`. `perSessionMemGiB`
is never given a value, a default, or a source. §1 line 46 says "N sessions on one **2–4 GiB VM**"; K3 line
488 requires "**4 concurrent sessions on a 4 GiB VM**". Back-solving, that forces `perSessionMemGiB` ≤
0.8125 — at which point the low end of the stated range (2 GiB) yields exactly 1 session, which defeats the
entire density argument the document calls "the density decision". Either the range or the acceptance
number is wrong and I cannot tell which.

**M5 — `session.settled` does not exist in the session lifecycle.**
§9 line 354 lists hook examples: "this is 'hooks': `session.settled`, `flow.failed`, `task.moved`". §5 line
252 gives the lifecycle: "`queued → starting → active → idle(ttl) → suspended → archived`". There is no
"settled" state or transition anywhere else in the document. I guessed it means "the agent stopped
producing output and is awaiting input", but that is a guess about the single most likely trigger condition
users will write.

**M6 — Retention tiering silently breaks the two properties the event log exists to provide.**
§2.1 line 89: "Retention: hot in Postgres, cold tiered to object storage after N days, with the projections
kept warm." N is never given. K1's acceptance, line 486: "Replay rebuilds a projection byte-identically."
If events older than N days live in object storage, replay either reads them back (mechanism not described,
cost not discussed) or cannot be byte-identical. §2.1 line 87 additionally says upcasters "translate old
events on read", which means a byte-identical replay also depends on upcaster determinism across versions.
None of this is addressed.

**M7 — "Every state change is an event" is irreconcilable with the example event types.**
§2.1 line 59: "Every state change in the system is an event, appended in the same transaction as the write
it describes." Line 66 gives `"session.text.delta"` as an example `type`, and line 65 requires
`seq: bigint; // per-stream, gapless`. Gapless per-stream sequencing requires serialising writes per
stream; doing that per token, in the same transaction as the write, for 50 concurrent sessions (K14, line
499) is a throughput claim with no mechanism behind it. The document never says whether token deltas are
actually persisted or merely transported, and §2.1 line 80 ("Chat history = `stream = session:<id>`,
filtered to message types") hints they are not, without saying so.

**M8 — Core types in the compute interface are never defined.**
§4 lines 197–206 reference `SandboxSpec`, `Placement`, `Unschedulable`, `SandboxRef` and an untyped `size`
in `resize?(ref, size)`. `plan()` is documented as returning "where it would go, what it would cost" (line
200), but `Placement` carries no cost field in any shown type, and §4 line 215 says the scheduler "ranks by
cost and boot time" — the cost model is never specified. §17.6 line 520 then requires "cost per project per
day from K2", measured against nothing defined.

**M9 — Board is described as a projection and as an owned entity, and I cannot tell which.**
§0 line 17: "Board = a projection over the event log, **not a separate datastore** (§8)." §8 line 331: "A
**projection over the event log**, with tasks as first-class entities", followed immediately by a concrete
`tasks(...)` table DDL with mutable columns (`state`, `rank`, `assignee_id`). §8 line 344: "**Core owns the
task entity**; connectors mirror it." §15 line 465 lists `tasks(...)` among the datastore tables. I guessed
the intent is "materialised projection, writes go through events, the table is derived and rebuildable" —
but if so, the two-way Jira sync in line 344 needs an inbound-write path that is never described.

**M10 — Two independent inbound-webhook paths, relationship undefined.**
§9 line 356: "`webhook` | signed inbound HTTP at `/hooks/<token>` | HMAC verified, replayable, payload
schema-validated before it becomes an event". §10 line 373: "`connector.ingress` plugins turn external
events into platform events, via webhook or poll." Both terminate in a platform event; both validate
payloads. Does a Jira webhook hit `/hooks/<token>` and then a connector, or does the connector own its own
endpoint? The repo trigger (line 357, "via git provider webhook") is a third variant. I cannot route an
inbound request from this document.

**M11 — Typed edges are claimed to be a save-time guarantee and a run-time failure mode in the same
paragraph, with no explanation of the gap.**
§7 lines 311–312: "A node's `outputSchema` must satisfy the next node's `inputSchema` — checked at *save*
time in the editor, **not at run time**." Lines 312–314: "Runtime validation failure is a typed
`StepInputInvalid` error that pauses the run". If the check is static and complete, there is no runtime
failure; if it is incomplete (dynamic payloads, `map` fan-out, subflows, Tier-2 Python nodes with no TS
types), the document should say which cases escape it. This matters because the same paragraph calls it
"the difference between a workflow system people trust and one they don't".

**M12 — `Bundles[]` is listed as a first-class object and never explained.**
§1 line 41: "`Bundles[]`  instructions, skills, MCP, plugins (resolved platform→ws→project)". The
resolution arrow is the whole content — is it override, merge, or append? §12 line 410 depends on it
("applied bundle versions" in the right rail) and §15 line 471 defers the table to v1. There is no
milestone in §16 that builds bundles at all, yet they appear in the shipped UI.

**M13 — "`approval.wait` materializes as a board card" has no mechanism, and the dependency order is
inverted against §16.**
§7 line 308 and §8 line 339 both assert flow approvals appear as board cards. §16 builds flows at K7 and
the board at K9, and §17.2 line 513 says "Do not start K9 before K7 works." So between K7 and K9,
`approval.wait` materialises as nothing. The document never says what a flow does with a human-in-the-loop
node when no board exists.

**M14 — The dogfooding guardrail is stated as a rule with no enforcement.**
§14 line 443: "**It must not hold deploy credentials for the control plane it runs on.**" Everything else
in §2.4 and §3 is enforced by capability checks and manifests; this one is prose. Given §13.4's own
argument that a prompt-injected agent escalates through flow authoring, "must not" without a mechanism is
the weakest link in the section the document itself calls "the sharpest edge" (§13.6, line 434).

**M15 — `sandboxd` is used before it is described, and never fully described.**
First use §2.5 line 124: "The wire contract between control plane and sandboxd (outbound mTLS WebSocket,
JSON-RPC)." I inferred it is an agent daemon running inside each sandbox VM. The document never states
that, never says how it is installed or updated (§2.5 line 126 says changing the protocol "is a breaking
change for every deployed sandbox" — so there is an upgrade problem, acknowledged and unsolved), and §11
line 391 gives it a further job ("refreshed by sandboxd over the tunnel") that implies it holds or proxies
credentials.

**M16 — "Untrusted tenants" is a policy concept with no home in the object model.**
§4 line 211: "`oci` (fast dev/CI mode, `isolation: "container"`, blocked by policy for untrusted tenants)".
§1's object model (lines 31–43) gives Tenant no trust attribute, and §15's schema has no tenants table at
all. Where is this policy evaluated, and against what column?

**M17 — "Session close" is not a lifecycle state.**
§5.1 line 232: "Session close → branch retained, worktree pruned." §5 line 253: "Archive prunes the
worktree, keeps the branch." These describe the same effect under two names, and "close" is absent from the
lifecycle on line 252. I guessed close == archive, but §5.1 omits suspend entirely, which per line 253
*keeps* the worktree — so the pruning rule depends on which word the reader believes.

**M18 — §12 makes the board and flows into UI plug-ins, contradicting their status elsewhere.**
§12 lines 412–413: "`ui.panel` plugins inject extra tabs and right-rail cards, so the board and flows are
themselves just the first two panels shipped against that contract." But §3's table (lines 144, 147) gives
flows and the board their own extension points (`flow.node`, `board.view`/`board.automation`), §2 makes the
flow runtime kernel-adjacent, and §16 builds both as core milestones (K7, K9). "Just a panel" and "core
milestone with its own extension points" cannot both be the build instruction.

**M19 — Preview URL and port scheme is left as an open question inside a section that is otherwise a
specification.**
§5.3 line 244: "Two sessions can both run a dev server on :5173 inside their own netns, or get remapped —
**decide once, document it**, and surface the real URL in the UI." This is the document telling itself to
do the work. The two options produce different preview hostnames, different sandboxd `ports.*` semantics
(line 257) and a different K3 acceptance test (line 488, "each with its own preview URL"). Unbuildable as
written.

### NIT

**N1 — `idemKey` is defined circularly.** §2.1 line 72: `idemKey?: string;        // unique per (stream, idemKey)`.

**N2 — "attempt-safe idemKey" (§2.2 line 98) is used once and never explained.** I guessed it means the key
must not incorporate the attempt counter, so retries collide deliberately.

**N3 — "exactly-once-ish delivery" (§2.1 line 82).** The hedge is honest but gives no target. §10 lines
368–371 describe the mechanism; the two should agree on what is guaranteed.

**N4 — "bounded overspend documented and measured" (§16 K4, line 489) names no bound.** Same for "DLQ after
N attempts" (§10 line 369), "disabled after N failures" (§3 line 181), "cold tiered after N days" (§2.1 line
89) and the stall detector's "N iterations" (§7 line 317). Five different unbound Ns.

**N5 — "Compose" (§16 K0, line 485) is never expanded.** Assumed Docker Compose.

**N6 — §18 is titled "Decisions needed before K2" but items 4–7 concern K7, K9, K10 and K12.** Only items
1–3 plausibly gate K2.

**N7 — `ExtensionPoint` and `Capability` types (§3 lines 167–168) are referenced in the manifest but only
listed informally in the table above.** No canonical enumeration exists in the document.

**N8 — "the prototype lessons (§12 there — still all true)" (line 5) and "v1 lesson #2 (OOM-killed agents)"
(§5.4 line 250).** The numbered lesson is cited as design justification and is unreadable from here.

---

## 4. COUNTS

| Grade | Count |
|---|---|
| BLOCKER | 5 |
| MAJOR | 19 |
| NIT | 8 |
| **Total** | **32** |
