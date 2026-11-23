# Harness Cloud — Architecture v2

> Supersedes the object model, extension model and build order in `BUILD_PROMPT_v1.md`.
> v1 remains the reference for: baked images, network policy, LiteLLM key topology, the credits ledger,
> and the prototype lessons (§12 there — still all true).

---

## 0. What changed from v1, and why

| v1 assumed | v2 requires | Consequence |
|---|---|---|
| project = sandbox = one chat | **workspace → many projects → one sandbox per project → many concurrent sessions per sandbox** | Sessions need filesystem, port and CPU isolation *inside* one VM (§5) |
| one repo, implicit | **many repos per project** | Bare clones + per-session git worktrees; per-repo scoped tokens (§11) |
| Incus VMs + BYO SSH, hardcoded | **pluggable compute**: split the host's own spec, Firecracker microVMs, remote pools, BYO | `ComputeDriver` with capability negotiation (§4) |
| free-form chat only | **predefined agentic flows, loops, graphs** (LangGraph-shaped) | A durable graph runtime is now core, not an add-on (§7) |
| no task tracking | **per-project board**, itself pluggable | Board = a projection over the event log, not a separate datastore (§8) |
| webhooks as a feature | **integration is the point**: in and out, any system | One connector contract + transactional outbox (§10) |
| "swappable" components | **everything plug-and-play and extendable** | Needs a *frozen kernel* and typed extension points, or it collapses (§3) |
| implicit audit table | **audit, recovery, replay, recurring as first-class** | All four fall out of one event log + one durable runtime (§2) |

**The single idea that makes all of this one system instead of six:**
board, hooks, triggers, recurring jobs, audit, outbound integrations, flow recovery and chat history
are *the same mechanism viewed from different angles* — an append-only event log plus a durable
step runtime. Build those two things extremely well and the rest are thin projections over them.

---

## 1. Object model

```
Tenant (deployment / billing root)
└── Workspace                     members, budget pool, policy, plugin set
    └── Project                   the unit of work; owns exactly one sandbox
        ├── Repos[]               many; bare clone on the sandbox, worktree per session
        ├── Sandbox (1)           compute target chosen by driver + policy
        │   └── Sessions[]        many concurrent agent sessions, isolated inside the VM
        ├── Board                 tasks; a task may own sessions and flow runs
        ├── Flows[]               graph definitions (versioned); runs are durable
        ├── Triggers[]            event | cron | webhook | board-transition → flow or session
        ├── Bundles[]             instructions, skills, MCP, plugins (resolved platform→ws→project)
        └── Connectors[]          ingress/egress bindings to outside systems
```

Rules that matter:
- **Project owns the sandbox 1:1.** Sessions share it. This is the density decision — N sessions on one
  2–4 GiB VM instead of N VMs — and it is why §5 is the hardest section in this document.
- **A session is addressable, resumable and attachable.** It survives sandbox stop/start (its worktree
  and harness state persist); it can be attached to a board task, started by a flow, or opened by a human.
- **Workspace is the budget and policy boundary.** Projects inherit; projects may narrow, never widen.

---

## 2. The kernel (NOT pluggable — this is the part that must never move)

Five things. If any of these are swappable you do not have a platform, you have a framework.

### 2.1 Event log
Every state change in the system is an event, appended in the same transaction as the write it describes.

```ts
type Event<P = unknown> = {
  id: string;              // ULID, globally monotonic
  stream: string;          // "project:<id>" | "session:<id>" | "flowrun:<id>" | "workspace:<id>"
  seq: bigint;             // per-stream, gapless
  type: string;            // "session.text.delta" | "task.moved" | "flow.step.completed" | ...
  tenantId: string; workspaceId: string; projectId?: string;
  actor: { kind: "user" | "agent" | "system" | "plugin"; id: string };
  at: string;              // ISO-8601
  payload: P;              // validated against a registered schema for `type`
  idemKey?: string;        // unique per (stream, idemKey)
  causationId?: string;    // the event that caused this one
  correlationId?: string;  // the user action / flow run that started the chain
};
```

What you get for free, and must not reimplement elsewhere:
- **Audit** = the log filtered by `actor` and administrative `type`s. Append-only, already immutable.
- **Chat history** = `stream = session:<id>`, filtered to message types.
- **Board state** = a projection; replay rebuilds it.
- **Recovery** = flow runs resume from their last committed step event.
- **Outbound integration** = subscribers on the log (§10), with an outbox for exactly-once-ish delivery.
- **Debugging** = `causationId` chains answer "why did this happen" in one query.

Schema registry: each `type` registers a zod schema at boot. Emitting an unregistered or invalid event
is a hard error, including from plugins. Event types are versioned (`task.moved.v2`) and upcasters
translate old events on read — you will need this within six months.

Retention: hot in Postgres, cold tiered to object storage after N days, with the projections kept warm.

### 2.2 Durable step runtime
One execution engine serves: provisioning state machines, flow runs, triggers, recurring jobs, image
builds, gateway/spend sync. Postgres-backed (`pg-boss` or `graphile-worker`) with a checkpoint model on top:

```ts
await ctx.step("clone-repo", { idemKey }, async () => { /* side effect */ });
```
`step()` memoizes by `(runId, stepKey, attempt-safe idemKey)`. A crash replays the run; completed steps
return their stored result instead of executing again. This is the entire basis of recovery. Non-idempotent
nodes must declare themselves so and get an at-most-once guard plus a compensation hook.

> Escape hatch, decided up front: if flows become the primary product, this layer is replaceable by
> Temporal or Restate. Keep the `step()`/`FlowNode` contract free of Postgres specifics so that port is
> a week, not a rewrite.

### 2.3 Identity and authz
One module. Every API handler, WS upgrade, MCP tool, flow node and plugin call goes through it.
Subject can be a user, an agent session, a flow run or a plugin — all four carry a capability set, so the
same check protects "can this user open a terminal" and "can this plugin read secrets".

```ts
can(subject, "project:terminal:open", { projectId })  // → Decision + reason (logged)
```
Capabilities are strings in a closed registry. Roles are named bundles of capabilities. Grants are
per-subject/per-resource rows. No ad-hoc `if (user.role === 'admin')` anywhere — lint rule enforced.

### 2.4 Secrets
Envelope encryption, per-record data keys, pluggable KMS backend *below* a fixed interface.
Everything else references secrets by URI (`secret://workspace/jira-token`) and resolves at use time,
never at storage time. Resolution is capability-checked and audited. Plugins never receive raw secrets
unless their manifest declared that exact secret scope.

### 2.5 The sandbox protocol
The wire contract between control plane and sandboxd (outbound mTLS WebSocket, JSON-RPC). Versioned.
Every compute driver and every harness lives behind it. Changing it is a breaking change for every
deployed sandbox, so it is kernel.

---

## 3. Extension model — how "everything is pluggable" survives contact with reality

Three tiers. Be strict about which tier a thing is in; the common failure is promoting kernel concerns
into tier 2 "for flexibility" and ending up unable to change anything.

**Tier 0 — Kernel (§2).** Not extensible. Versioned API consumed by everyone else.

**Tier 1 — Typed extension points.** In-process TypeScript modules, loaded from a manifest, running with
the host's trust. First-party and reviewed third-party only.

| Point | Contract | Examples |
|---|---|---|
| `compute.driver` | §4 | incus-local, incus-cluster, firecracker, oci, byo-ssh, cloud-* |
| `harness.adapter` | §6 | pi, claude-code, codex, opencode |
| `flow.node` | §7 | llm.agent, shell.run, http.request, git.pr, approval.wait, map, loop |
| `trigger.source` | §9 | cron, event, webhook, board.transition, repo.push, schedule |
| `connector.ingress` / `connector.egress` | §10 | jira, slack, linear, s3, kafka, generic-http |
| `board.view` / `board.automation` | §8 | kanban, table, timeline, "on move → run flow" |
| `model.gateway` | §6.3 | litellm (default), direct-anthropic, bedrock-only |
| `auth.provider`, `secrets.backend`, `storage.backend` | kernel-adjacent | oidc/saml, vault/kms/age, s3/fs |
| `ui.panel` | §12 | extra project tab, right-rail card, card renderer |

**Tier 2 — Out-of-process plugins.** Untrusted or third-party. Run as a container or worker with a
capability token and no DB access. MCP servers, custom flow steps, webhook transformers, a Python
LangGraph runner. Communicate over the same JSON-RPC used for sandboxd. **An untrusted plugin never runs
in the API process** — that is the rule that keeps "pluggable" from meaning "one bad plugin takes down the
control plane".

Manifest, identical shape for both tiers:

```ts
type PluginManifest = {
  id: string;                    // "acme.jira"
  version: string;               // semver
  apiVersion: string;            // host API range this is built against, e.g. "^1.2"
  runtime: "in-process" | "worker" | "container";
  trust: "core" | "verified" | "untrusted";
  provides: Array<{ point: ExtensionPoint; name: string }>;
  capabilities: Capability[];    // "events:read:project", "secret:read:workspace/jira-token",
                                 // "http:egress:api.atlassian.com", "sandbox:exec"
  config: JSONSchema;            // rendered as an admin form, validated on save
  migrations?: string;           // owns its own tables in its own schema, never touches core tables
};
```

Hard rules:
1. Plugins get a **`PlatformAPI` facade**, never the DB handle, never the Drizzle client.
2. Capabilities are **declared, reviewed at install, enforced at call time**, and shown to the admin.
3. Host API is semver. Loader refuses an incompatible `apiVersion` rather than crashing at runtime.
4. Plugins own their own Postgres schema. Core tables are off limits. Uninstall drops the schema.
5. Every plugin call is traced and billed to the calling tenant (`otel` span + duration histogram).
6. A plugin that throws or times out is circuit-broken, disabled after N failures, and surfaced in the
   admin console. Degrade, never cascade.

---

## 4. Compute layer

```ts
type ComputeCapabilities = {
  isolation: "vm" | "microvm" | "container" | "host";   // honest labelling, drives the policy check
  snapshot: boolean; restore: boolean; resize: boolean; pause: boolean;
  bootP50Ms: number; maxSessions: number;
  nested: boolean;        // can run Docker inside?
  gpu: boolean;
};

interface ComputeDriver {
  id: string;
  capabilities(): ComputeCapabilities;
  plan(spec: SandboxSpec): Promise<Placement | Unschedulable>;  // where it would go, what it would cost
  create(spec: SandboxSpec, placement: Placement): Promise<SandboxRef>;
  start(ref): Promise<void>; stop(ref): Promise<void>; destroy(ref): Promise<void>;
  snapshot?(ref, name): Promise<void>; restore?(ref, name): Promise<void>;
  resize?(ref, size): Promise<void>;
  metrics(ref): Promise<{ cpu: number; memBytes: number; diskBytes: number }>;
}
```

Drivers to ship, in order: `incus-local` (carve the host's own CPU/RAM/disk into VM slices — this is the
default single-box install), `oci` (fast dev/CI mode, `isolation: "container"`, blocked by policy for
untrusted tenants), `byo-ssh`, `firecracker`, `incus-cluster`, cloud drivers later.

**Capability negotiation, not lowest common denominator.** A project spec declares what it *needs*
(`needsDocker`, `needsSnapshot`, `minIsolation`). The scheduler filters drivers by capability, then ranks by
cost and boot time. A feature that needs snapshots is simply unavailable (with a clear reason in the UI)
on a driver that lacks them — never silently degraded.

Host-spec splitting (`incus-local`): the admin declares the host budget (reserve N cores / M GiB for the
control plane), the scheduler maintains an allocatable pool with an overcommit ratio per resource, and
refuses placement rather than thrashing. Warm pool per image version sits on top, as in v1.

---

## 5. Many sessions, one sandbox — the hard part

This is where the design earns or loses. Four conflicts to solve inside one VM:

**5.1 Filesystem — git worktrees.**
One bare clone per repo at `/srv/git/<repo>.git`. Each session gets `/work/<sessionId>/<repo>`, a worktree
on its own branch `session/<shortId>`. Sessions therefore cannot corrupt each other's files, `git` stays
fast (one object store), and "what did this session change" is `git diff` against the base. Session close →
branch retained, worktree pruned. Promotion to the project's main branch is an explicit action (PR or merge),
never implicit.

**5.2 CPU/memory — one cgroup per session.**
Each session runs in a transient systemd scope `hc-session-<id>.scope` with `CPUWeight`, `MemoryMax`,
`MemoryHigh`, `TasksMax`, `IOWeight`. A runaway build starves itself, not its neighbours. sandboxd reports
per-scope metrics as session telemetry.

**5.3 Ports — per-session ranges.**
sandboxd allocates a range per session and reports `ports.changed` tagged with `sessionId`. Preview URLs
become `<port>--<sessionId>.preview.<domain>`; the project's "main" preview is an alias to the session the
user is currently viewing. Two sessions can both run a dev server on :5173 inside their own netns, or get
remapped — decide once, document it, and surface the real URL in the UI.

**5.4 Admission control.**
`maxSessions = min(floor((memGiB - 0.75) / perSessionMemGiB), vCPU * 2)`, capped by the driver's
`capabilities().maxSessions`. Beyond that, sessions queue with a visible "waiting for capacity" state and
the project offers "resize sandbox". Never oversubscribe silently — v1 lesson #2 (OOM-killed agents) came
from exactly this.

Session lifecycle: `queued → starting → active → idle(ttl) → suspended → archived`. Suspend keeps the
worktree and harness session file; resume is seconds. Archive prunes the worktree, keeps the branch and
the event stream.

sandboxd RPC gains a session dimension on everything: `session.create/prompt/abort/attach/detach`,
`pty.open{sessionId}`, `fs.*{sessionId}`, `ports.list{sessionId}`.

---

## 6. Harness layer

Unchanged in shape from v1 §6 (`HarnessAdapter`, normalized `HarnessEvent`, LiteLLM as `model.gateway`),
with four corrections:

1. **`HarnessEvent` gains `sessionId`, `seq`, `at`** — it is persisted to the event log, so it needs log fields.
2. **Add `approval.request`** as a distinct event from `question` (permission to run a command vs. asking the
   user something). All four harnesses expose these differently; normalizing them is a named work item, not a line item.
3. **Add `tool.output`** (truncated, with a pointer to full output in object storage) so the UI can render
   diffs and the board can attach artifacts.
4. **One harness for v1** (pi). The adapter interface exists; the other three are Tier-1 plugins shipped later.
   The 4×4 harness × API-family contract matrix from v1 §6.3 is a maintenance liability, not a v1 deliverable.

The gateway itself is now `model.gateway` extension point, with LiteLLM as the default implementation —
so a deployment that must call Bedrock directly, or has no LiteLLM, is a config change.

---

## 7. Flows — the durable graph runtime

LangGraph's shape (nodes, conditional edges, state, loops, human-in-the-loop) on top of §2.2. Built in TS
so it shares the kernel; a Python LangGraph runner is supported as a Tier-2 out-of-process node type for
teams that want the real thing.

```ts
interface FlowNode<I, O> {
  type: string;                         // "llm.agent", "shell.run", "http.request", "approval.wait"
  inputSchema: ZodType<I>;              // "each step proper parsing" — enforced at the boundary
  outputSchema: ZodType<O>;
  idempotent: boolean;
  execute(ctx: NodeCtx, input: I): Promise<O>;
  compensate?(ctx: NodeCtx, input: I, output: O): Promise<void>;
}

type NodeCtx = {
  runId: string; nodeId: string; attempt: number;
  step<T>(key: string, fn: () => Promise<T>): Promise<T>;   // memoized side effect
  emit(type: string, payload: unknown): Promise<void>;
  session(opts): Promise<SessionHandle>;    // start/attach an agent session in the project sandbox
  secret(uri: string): Promise<string>;     // capability-checked
  budget: { spentUsd(): number; assertUnder(limit: number): void };
  signal: AbortSignal;                      // cancellation propagates
  logger: Logger;                           // structured, correlated
};
```

Built-in node types: `llm.agent` (runs a harness session to completion or to a condition), `shell.run`,
`http.request`, `git.commit` / `git.pr`, `approval.wait` (materializes as a board card), `condition`,
`map` (fan-out with concurrency limit), `loop` (with guards), `subflow`, `wait.event`, `wait.until`.

**Typed edges.** A node's `outputSchema` must satisfy the next node's `inputSchema` — checked at *save*
time in the editor, not at run time. Runtime validation failure is a typed `StepInputInvalid` error that
pauses the run and raises a board card with the actual vs. expected shape. This is the "proper parsing at
each step" requirement, and it is the difference between a workflow system people trust and one they don't.

**Loops need guards, always.** `maxIterations`, `maxCostUsd`, `maxWallClockMs`, and a stall detector
(no change in the designated state keys across N iterations → halt with `StalledLoop`). An unguarded agent
loop against a metered gateway is an incident.

**Versioning.** A run pins its flow definition version at start. Editing a flow never mutates in-flight runs.
Resuming an interrupted run uses the pinned version. Migrating in-flight runs is explicitly unsupported.

**Recovery.** Run state = pinned definition + committed step events. Worker dies → another picks it up →
completed steps replay from the log, the next one executes. Visible as a timeline in the UI, with retry /
skip / resume-from-step controls for admins.

---

## 8. Board

Not a separate app. A **projection over the event log**, with tasks as first-class entities:

```
tasks(id, project_id, key, title, state, assignee_kind, assignee_id, labels[],
      linked_session_ids[], linked_flow_run_id, linked_pr_urls[], parent_id, rank, meta jsonb)
```

- A task may be assigned to a **human or an agent**. Assigning to an agent spawns or attaches a session.
- `approval.wait` nodes and failed flow steps appear as cards automatically — the board becomes the
  human-in-the-loop inbox, which is the main reason to build it rather than integrate Jira.
- **Automations** (`board.automation` extension point): "when task enters *In Review* → run flow `review`",
  "when flow run fails → create card". These are just triggers (§9) with a board-shaped UI.
- **Views** (`board.view`): kanban ships first; table, timeline, per-agent swimlanes are plugins.
- Two-way sync to Jira/Linear is a `connector`, not core. Core owns the task entity; connectors mirror it.

---

## 9. Triggers, hooks, recurring

One table, one runtime, four sources — all of them produce the same thing: a job on the step runtime.

| Source | Fires on | Notes |
|---|---|---|
| `event` | any event matching a filter (`type` glob + JSONPath predicate) | this is "hooks": `session.settled`, `flow.failed`, `task.moved` |
| `cron` | schedule with timezone | "recurring options"; jitter the minute, skip overlapping runs by default |
| `webhook` | signed inbound HTTP at `/hooks/<token>` | HMAC verified, replayable, payload schema-validated before it becomes an event |
| `repo` | push / PR / tag via git provider webhook | per-repo, mapped into the same event shape |

Trigger → action: start a flow run, start a session with a prompt template, call a connector egress, or
emit an event. Every trigger has: an enable flag, a concurrency policy (`allow | skip | queue | cancel-previous`),
a rate limit, a dead-letter queue, and a run history with the resulting `correlationId` so you can trace
trigger → flow → session → commit in one view.

---

## 10. Integrations — in and out

**Egress.** Subscribers on the event log write to a **transactional outbox** in the same transaction as
the event. A delivery worker drains it: retries with exponential backoff, DLQ after N attempts, signed
payloads (HMAC + timestamp + replay window), per-destination circuit breaker, and manual replay from the
log. Destinations are `connector.egress` plugins: generic HTTP/webhook, Slack, Kafka/NATS, S3, SQL sink.

**Ingress.** `connector.ingress` plugins turn external events into platform events, via webhook or poll.
Payload is schema-validated and normalized before it enters the log — never store raw third-party JSON as
if it were a platform event.

**Programmatic surface.** Three faces on one action layer (so they can never drift):
- REST `/api/v1` + OpenAPI generated from the same zod schemas
- MCP server at `/mcp` — the platform is drivable by other agents
- Typed TS client generated from the OpenAPI spec

Everything above goes through `authz` with the same capability names. Idempotency keys on creates,
cursor pagination, per-subject rate limits, ETags on reads.

---

## 11. Multi-repo

- Project declares N repos; each gets a bare clone on the sandbox and a mount path.
- **Credentials are minted per repo, short-lived, on demand** — never a long-lived PAT with org scope sitting
  in the VM. GitHub App installation tokens (1h) or equivalent, refreshed by sandboxd over the tunnel.
  This matters more now: one compromised project session would otherwise reach every connected repo.
- Branch/worktree per session (§5.1). A session's output is a branch and, optionally, a PR.
- Cross-repo changes in one session are supported (that's the point of multi-repo) — the PR node opens one
  PR per repo and links them to the same task.
- Workspace durability: the sandbox is disposable; **the git remote is the source of truth.** Uncommitted
  work is protected by auto-commit to the session branch on idle/suspend, not by VM snapshots.

---

## 12. UI implications (answering the screenshot)

The Claude Code shell you showed is the right *skeleton*, wrong *content* (see the five flaws noted earlier).
Mapped onto this model:

- **Left rail:** workspace switcher → project list (with sandbox state dot) → within a project, sessions list.
  "Recents" becomes *sessions*, which are durable objects, not chat scrollback.
- **Center:** the active surface, tabbed per project — **Chat/Session · Board · Flows · Repos · Terminal · Preview · Settings**.
- **Right rail:** *project status*, not model telemetry — sandbox state and size, active sessions and their
  cgroup usage, ports, repos and branch per session, spend vs. budget, applied bundle versions, recent events.
- **Terminal tab** is capability-gated (`project:terminal:open`), recorded, and scoped to a chosen session's worktree.
- `ui.panel` plugins inject extra tabs and right-rail cards, so the board and flows are themselves just the
  first two panels shipped against that contract.
- User-vs-admin is **capability-driven rendering of one UI**, not two apps. A member without `terminal` simply
  does not see the tab. This replaces v1's hard user/admin app split, which does not survive "devs need a terminal".

---

## 13. Security deltas from v1

v1 §9 still applies in full. New surface introduced by this design:

1. **Plugins.** Untrusted plugins out-of-process with capability tokens; declared capabilities enforced and
   displayed; per-plugin egress allowlist; circuit breakers; signed plugin bundles with pinned digests.
2. **Multi-session.** Session A must not read session B's worktree: separate uid or mount namespace per
   session, not just separate directories. Decide and test this explicitly — it is a real tenancy boundary now.
3. **Multi-repo credentials.** Short-lived per-repo tokens, minted on demand (§11). Never a broad PAT in the VM.
4. **Flows can act outside the sandbox.** `http.request` and connector nodes run in the control plane with
   workspace credentials — a prompt-injected agent that can *author a flow* escalates. So: authoring a flow
   with network/secret nodes requires an elevated capability, agent-authored flows land as drafts needing
   human approval, and node-level egress is allowlisted per workspace.
5. **Webhook ingress** is unauthenticated by nature: HMAC, timestamp window, replay cache, strict payload
   schema, and per-token rate limits.
6. **Dogfooding (§14)** is the sharpest edge; see its guardrail.

---

## 14. Running the platform on itself

Supported and useful — with one hard line:

- A project may connect the platform's own repos, run its tests, and open PRs. Good.
- **It must not hold deploy credentials for the control plane it runs on.** Deployment runs on a separate
  runner with a separate identity, triggered by a human-approved pipeline outside the sandbox.
- Self-modification of a running control plane by an agent inside that control plane is how you get a
  bricked deployment with no path back. Build → test → PR is the loop; merge and deploy stay human.

---

## 15. Data model additions

```
workspaces(id, tenant_id, name, settings jsonb)
projects(id, workspace_id, name, policy jsonb, sandbox_id, status, status_detail)
project_repos(project_id, repo_id, mount_path, default_branch)
repos(id, workspace_id, provider, remote_url, credential_ref)
sessions(id, project_id, task_id, harness, model, branch, worktree_path, state,
         cgroup_scope, port_range, created_by, last_active_at)
events(id, stream, seq, type, tenant_id, workspace_id, project_id, actor jsonb,
       payload jsonb, idem_key, causation_id, correlation_id, at)        -- append-only, partitioned by month
outbox(id, event_id, destination_id, attempts, next_attempt_at, state, last_error)
flows(id, project_id, name) / flow_versions(id, flow_id, version, graph jsonb, created_by)
flow_runs(id, flow_version_id, project_id, trigger_id, state, started_at, ended_at, cost_micros)
flow_steps(run_id, node_id, attempt, state, input jsonb, output jsonb, checkpoint jsonb, error jsonb)
tasks(...)  -- §8
triggers(id, project_id, source, config jsonb, action jsonb, concurrency, enabled, last_fired_at)
plugins(id, version, trust, runtime, manifest jsonb, config jsonb, state, installed_by)
plugin_grants(plugin_id, capability, scope, scope_id)
compute_hosts(id, driver, capacity jsonb, allocatable jsonb, state)
```
Plus everything from v1 §8 (users, orgs→workspaces, grants, sandboxes, images, credentials,
gateway_keys, bundles, wallets/ledger, audit → now a view over `events`).

Tenant id on every row; enforced in the repository layer **and** Postgres RLS. Not "if feasible" — required,
because plugins now execute code near your data.

---

## 16. Build order

Each milestone ends with its acceptance tests green.

| # | Milestone | Done when |
|---|---|---|
| **K0** | Monorepo, CI, Compose, auth, workspaces, `authz` capability registry | role/capability matrix is table-driven and green |
| **K1** | **Kernel: event log + schema registry + projections + step runtime + secrets** | kill a worker mid-run; the run resumes and produces identical output. Replay rebuilds a projection byte-identically |
| **K2** | `ComputeDriver` + `incus-local` (host splitting) + baked image + warm pool | project → sandbox ready <10s warm, <60s cold; scheduler refuses placement instead of overcommitting |
| **K3** | sandboxd + **multi-session** (worktrees, cgroups, port ranges, admission) | 4 concurrent sessions on a 4 GiB VM, isolated FS, no OOM, each with its own preview URL |
| **K4** | Gateway (`model.gateway` + LiteLLM), project keys, budgets | allowlist enforced; revoked key fails <5s; bounded overspend documented and measured |
| **K5** | **pi adapter**, normalized events into the log, chat + preview UI | E2E: prompt → files changed → preview renders → events replayable as history |
| **K6** | Multi-repo: clones, per-session branches, short-lived tokens, PR node | cross-repo change in one session opens two linked PRs |
| **K7** | **Flow runtime**: node contract, typed edges, loops with guards, approval nodes, run timeline | a flow survives a worker kill mid-run; a loop halts on cost guard; bad step input pauses with a typed error |
| **K8** | **Triggers**: cron, event, webhook, repo; concurrency policies, DLQ, run history | trigger → flow → session → PR traceable by one `correlationId` |
| **K9** | **Board**: tasks, agent assignment, approval inbox, automations, kanban view | failing flow step raises a card; moving a card runs a flow |
| **K10** | **Plugin system**: manifest, loader, capability enforcement, out-of-process runtime, admin UI | an untrusted plugin that crashes or hangs is circuit-broken with zero impact on the API |
| **K11** | Integrations: outbox, egress/ingress connectors, public REST + MCP + typed client | signed delivery with retries, DLQ and replay; MCP client can drive a full project lifecycle |
| **K12** | Credits/ledger, spend sync, quotas per workspace | spend stops at zero; drift <$0.01/key/day with an alarm |
| **K13** | More drivers (`firecracker`, `byo-ssh`, `oci`) and more harnesses as plugins | capability negotiation picks correctly; a missing capability is a clear UI message, never a silent downgrade |
| **K14** | Hardening: tenancy tests, RLS, backup/restore drill, OTel dashboards, load test | security suite (v1 §11) + 50 concurrent sessions across 10 projects |

Note the inversion from v1: **the kernel (K1) comes before compute.** Everything downstream — board, flows,
triggers, audit, recovery, integrations — is cheap if K1 is right and impossible to retrofit if it isn't.

---

## 17. Where this goes wrong (read before starting)

1. **"Everything is pluggable" is the primary failure mode of this design.** A system with no fixed centre
   cannot be optimized, debugged or upgraded. The mitigation is §2: a small kernel you commit to and refuse
   to make configurable. Every future "let's make X swappable" request should be answered with "which tier?"
2. **This is six products** (orchestration, agent runtime, workflow engine, project tracker, plugin platform,
   billing). Sequencing is now the main engineering risk, not architecture. K1–K5 is a real product on its
   own; K7–K10 is a second one. Do not start K9 before K7 works.
3. **Durable workflow engines are harder than they look** — retries, idempotency, cancellation, in-flight
   versioning, clock skew. Budget for it properly, keep the Temporal escape hatch open (§2.2).
4. **Multi-session makes merge conflicts a user-facing concept.** Three agents on three branches in one repo
   will collide. The UI must show branch/worktree per session and make promotion explicit, or users will lose work.
5. **Agent-authored flows are a privilege escalation path** (§13.4). Treat flow authoring as a privileged action.
6. **Economics.** One VM per project with warm pools is expensive; multi-session density is what makes it
   viable. Instrument cost per project per day from K2, not at K12.
7. **Dogfooding ambition vs. blast radius** (§14). Keep deploy outside.

---

## 18. Decisions needed before K2

1. Single-box `incus-local` first, or cluster from day one? (Sets warm pool and scheduler complexity.)
2. Session isolation level inside a sandbox: separate uid, or full user namespace per session? (§13.2)
3. Sandbox egress: allowlist by default, or open? Open + free project creation = a mining service.
4. Flow runtime: build on `pg-boss` with our own checkpointing (recommended for v1), or adopt Temporal now?
5. Board: own the task entity (recommended — the approval inbox depends on it), or integrate Jira/Linear only?
6. Who may install plugins — workspace admin, or platform superadmin only? (Recommend: untrusted = workspace,
   in-process Tier 1 = superadmin.)
7. Does a flow run count against the same wallet as chat? (It should; it is the same gateway spend.)
