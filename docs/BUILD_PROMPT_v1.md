# Build Prompt: Harness Cloud (production)

> Give this whole file to the engineer or coding agent building the production system.
> It covers the goal, the architecture, the contracts between parts, the order to build in, and what "done" means.
> A working prototype already sits in this repo (`src/`, `public/`). Read the "Lessons from the prototype" section before writing code.

---

## 0. Your role and how to work

You are a senior platform engineer building a production service. Work in small, verified steps:

1. Before each milestone, write down its acceptance tests. Make them pass before you move on.
2. Prefer existing, boring technology. Never hand-roll auth, crypto, queues or protocol parsers.
3. Every boundary in this document (sandbox provider, harness adapter, LLM gateway, DB) sits behind an interface, so any one of them can be swapped without touching the rest.
4. Security rules in §9 are requirements, not suggestions. If a feature conflicts with them, stop and raise it.
5. Where this document says **VERIFY**, the fact depends on a third-party version. Confirm it with a contract test against the real tool, not from memory.

---

## 1. The product in one paragraph

A self-hosted platform where each **project** gets its own isolated **sandbox**. A sandbox is either a tiny VM we boot from a pre-baked image, or a server the customer gives us over SSH. In it we install the dev tooling (Docker, git, runtimes), a **harness** (the coding agent: **pi** by default, or Claude Code, Codex or OpenCode), and the admin's **bundles** (instructions, skills, plugins, MCP servers). Normal users see only a **chat** with the agent and a **live preview** of what it builds. Admins see everything technical. All model traffic goes through one **LLM gateway** (LiteLLM), so any provider works, keys stay on the server, and spend is metered and capped.

```
                ┌──────────────────────── Control plane (our server) ────────────────────────┐
 Users ──HTTPS──►  Web app (chat + preview)        API (REST + MCP + webhooks)                │
 Admins ─HTTPS──►  Admin console (technical)       Workers (provisioning, image builds, sync) │
                │  Postgres (app DB)   Secrets (KMS/envelope)   Preview proxy   Audit log      │
                │  LLM gateway: LiteLLM (+ its own Postgres) ──► Anthropic/OpenAI/Gemini/...   │
                └──────────────▲───────────────────────────────▲──────────────────────────────┘
                               │ outbound mTLS WebSocket       │ HTTPS (project virtual key)
                ┌──────────────┴─────────── Sandbox (one per project) ─┴──────────────────────┐
                │  sandboxd (our daemon)  →  harness adapter  →  pi | claude-code | codex | … │
                │  Docker, git, node, python, toolchains        /workspace (project files)     │
                └──────────────────────────────────────────────────────────────────────────────┘
                   managed: Incus VM from baked image      or      BYO: customer host via SSH
```

### Non-goals (v1)
- Multi-region and multi-host scheduling beyond one Incus cluster.
- Our own model hosting.
- A general IDE. Admins get a terminal and a file viewer; users get chat and preview only.
- Marketplace or public sharing of bundles.

---

## 2. Roles and what each one can see

| Capability | User (member) | Org admin | Superadmin |
|---|---|---|---|
| Log in, list own projects, create a project (if org allows) | ✓ | ✓ | ✓ |
| Chat with the project agent, see the preview | ✓ | ✓ | ✓ |
| Connect own model key (BYOK) or request access from the admin | ✓ | ✓ | ✓ |
| Terminal, files, logs, VM controls, SSH details | only if granted `terminal` on that project | ✓ (own org) | ✓ |
| Manage members, grants, org keys, budgets/credits | | ✓ | ✓ |
| Choose a project's harness | only if the org enables `allowProjectHarnessChoice` | ✓ | ✓ |
| Set the org's default harness and model allowlist | | ✓ | ✓ |
| Manage bundles (instructions, skills, plugins, MCP) | | org scope | platform scope |
| Images, sandbox hosts, BYO hosts, gateway/provider config, global defaults | | | ✓ |

Rules:
- **Users never see** VM names, IPs, harness internals, tool calls in raw form, logs or the terminal. The chat UI shows a friendly summary of tool activity ("Edited 3 files", "Ran tests").
- `terminal` is a per-user, per-project grant. Every use is audited and recorded (§9).
- Permission checks live in one module (`authz`). Every API handler, WebSocket upgrade and MCP tool calls it. There are no ad-hoc role checks anywhere else.

---

## 3. Technology choices (use these unless there is a strong reason not to)

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere (control plane, sandboxd, UI) | One language; pi, Claude Agent SDK and Codex SDKs are TS-first |
| Runtime | Node 22 LTS (or Bun if every dependency passes CI on it) | pi requires Node ≥ 22.19 |
| API | Hono or Fastify, with an OpenAPI spec generated from zod schemas | Typed contracts and client generation |
| DB | Postgres 16 + Drizzle ORM + checked-in migrations | Swappable, typed; PGlite only for local dev and tests |
| Jobs | pg-boss or graphile-worker (Postgres-backed) | No Redis needed; durable retries |
| Auth | Better Auth (email/password, OIDC/SAML SSO, orgs) or an equivalent maintained library | Do not hand-roll sessions or password storage |
| Secrets | Envelope encryption: per-record data key, wrapped by KMS / Vault / age master key | Rotatable; the DB alone leaks nothing |
| LLM gateway | LiteLLM Proxy with its own Postgres (virtual keys, budgets, spend logs) | Every provider, three API shapes, budgets |
| Sandboxes | Incus VMs (clusterable) behind a `SandboxProvider` interface, plus `byo-ssh` | Real VM isolation, Docker inside, snapshots, ACLs |
| Sandbox ↔ control plane | sandboxd dials out over a mTLS WebSocket, JSON-RPC 2.0 | Works through NAT and for BYO hosts; no inbound ports on sandboxes |
| UI | React + Vite + TanStack Query; xterm.js for the terminal | Standard, testable |
| Observability | OpenTelemetry traces and metrics, structured JSON logs, Prometheus + Grafana | Debug provisioning and chat latency |
| Packaging | Docker Compose for single-host installs; Helm chart later | Simple to self-host |

---

## 4. Components

### 4.1 Control plane API
- REST under `/api/v1`, documented in OpenAPI. A **streaming endpoint** (SSE or WebSocket) delivers chat events and provisioning progress.
- **MCP server** at `/mcp` exposes the same actions (list/create projects, send message, get status) so other agents can drive the platform. It uses the same `authz`.
- **Webhooks** (signed) fire for `project.ready`, `project.failed`, `budget.exhausted` and `access.requested`.
- Idempotency keys on all creates. Cursor pagination everywhere. Rate limits per user and per org.

### 4.2 Workers
State machines run as jobs:
- **Provisioning:** `requested → allocating → booting → enrolling → applying_bundles → starting_harness → ready`, with `failed(reason)` and retries. Each transition emits a progress event that the UI shows live.
- **Image builds:** build, test, publish a versioned base image (§5.1).
- **Gateway sync:** keep LiteLLM keys, budgets, BYOK model entries and the allowlist in sync with the app DB. This runs on every change, plus a periodic reconciliation.
- **Spend sync:** pull spend from LiteLLM into the credit ledger (§7.4).
- **Idle reaper:** stop sandboxes idle for longer than the org policy allows. Start them again on the next chat; with a warm image this takes about 30 seconds.

### 4.3 sandboxd (runs inside every sandbox)
A small Node service, installed into the base image and onto BYO hosts by the same installer.

**Enrollment.** On first boot it reads a one-time enrollment token (from cloud-init, or from SSH bootstrap for BYO). It exchanges the token for a per-sandbox mTLS client certificate, then keeps a single outbound WebSocket to the control plane open, reconnecting with backoff.

**Its RPC surface (JSON-RPC over the socket):**

| Method / event | Purpose |
|---|---|
| `health`, `info` | Version, harness, resources, image version |
| `progress` (event) | Provisioning step updates |
| `bundle.apply(manifest)` | Materialize instructions, skills, plugins and MCP config for the active harness (§6) |
| `harness.configure(cfg)` | Model catalog, gateway URL, project key, defaults |
| `session.create / prompt / abort / list / history` | Chat through the harness adapter |
| `session.events` (stream) | Normalized `HarnessEvent`s (§5.3) |
| `ports.list`, `ports.changed` (event) | Listening ports, for the preview |
| `pty.open / write / resize / close` | Terminal. The control plane only allows this for users with the `terminal` grant |
| `fs.list / read` (and `write` for admins) | File viewer |
| `exec` | Admin-only one-off commands, audited |

Other requirements:
- It runs as a systemd service, under an unprivileged `sandboxd` user plus a narrow sudo policy, or as root inside the VM. The VM is the security boundary; the harness runs as root inside it by design ("full access").
- It never stores provider keys. It holds only the project's **gateway virtual key** (§7), which is scoped, capped and revocable.

### 4.4 Preview proxy
- URL shape: `https://<port>--<projectId>.preview.<domain>` on a **separate registrable domain** from the console, so preview pages can't read console cookies.
- Auth: a short-lived signed preview cookie, issued by the console when the user opens the project (scoped to that project). No direct VM IPs are ever exposed.
- Traffic is forwarded through the sandboxd tunnel (the `ports` channel) or over the private network to the VM. HTTP and WebSocket both work (for dev servers with HMR).
- The preview frame shows the port list from `ports.changed`, auto-selects the first web port, and offers an "open in new tab" link.

### 4.5 Web app (users) and admin console
- **User app:**
  - Login (SSO or password).
  - Onboarding: org → project (provisioning starts immediately) → model access.
  - Project page: chat (streaming, with friendly tool summaries) beside the preview, both resizable. The preview shows live progress while the sandbox boots.
  - Settings: connect my key (provider + key), or "request access" from the admin. The request goes to the org admin queue; the admin approves by granting credits or an org key.
- **Admin console:**
  - Orgs, users, roles, terminal grants.
  - Projects with technical detail: sandbox, host, image, harness, logs, terminal, files, restart.
  - Sandbox hosts and BYO hosts; images and versions.
  - Bundles, with assignment to platform, org or project.
  - Harness defaults; model catalog and allowlists.
  - Provider credentials; budgets, credits and ledger.
  - Audit log; gateway health.

---

## 5. Sandboxes

### 5.1 Baked images (managed VMs)
- **One installer script**, `provision.sh`, is the single source of truth for what a sandbox contains. It is idempotent: every step checks before installing. The image builder and BYO bootstrap both use it. Contents:
  - OS updates
  - Docker Engine + compose plugin
  - git, curl, build-essential, Node LTS, Python 3, uv
  - Harness CLIs: pi, Claude Code, Codex, OpenCode. Pin versions in an `images/versions.lock`.
  - sandboxd
  - openssh-server (admin SSH only, off by default)
- **Image pipeline** (a worker job, or `make image` in CI):
  1. Launch a builder VM.
  2. Run `provision.sh`.
  3. Run image tests (§11).
  4. Clean machine identity: `cloud-init clean --logs --machine-id`, delete SSH host keys.
  5. Publish as `harness-base:<semver>`.
  6. Delete the builder.
- Projects pin an image version. Admins can roll forward or roll back per org.
- **Warm pool.** Keep N pre-booted, unassigned VMs per image version (default 2). Assigning one turns "create project" into roughly a 5-second operation. Refill the pool in the background.
- **Default size:** 2 vCPU (shared), 2 GiB RAM, 10 GiB disk. Admins can choose per-org tiers. 1 GiB is too small: the agent was OOM-killed once Docker was running.

### 5.2 BYO host over SSH
1. An admin (or an allowed user) adds a host: address, port, user, and auth. Preferred auth: we generate a keypair and show the public key to add to `authorized_keys`; a private key upload is also accepted. Optionally a host-key fingerprint (we pin it on first connect and warn on change).
2. **Preflight** over SSH checks: supported OS (Ubuntu 22.04/24.04, Debian 12), arch, CPU/RAM/disk minimums, sudo without password (or a provided password, used once), outbound HTTPS to the control plane, and any existing Docker. Show a clear pass/fail report.
3. **Bootstrap:** copy and run `provision.sh` with a one-time enrollment token. sandboxd enrolls and dials out. From then on, SSH is not needed; the admin may remove our key.
4. The **trust model** is different and must be shown in the UI: the customer's host is their trust domain. One project per BYO host by default. Option: run each project in its own Incus/LXD system container on that host, if Incus is present.

### 5.3 The `SandboxProvider` interface

```ts
interface SandboxProvider {
  kind: "incus" | "byo-ssh";                       // later: "firecracker", "cloud-<x>"
  create(spec: SandboxSpec): Promise<SandboxRef>;   // spec: image version, size, network policy, enrollment token
  start(ref: SandboxRef): Promise<void>;
  stop(ref: SandboxRef): Promise<void>;
  destroy(ref: SandboxRef): Promise<void>;
  snapshot?(ref: SandboxRef, name: string): Promise<void>;
  restore?(ref: SandboxRef, name: string): Promise<void>;
  resize?(ref: SandboxRef, size: SandboxSize): Promise<void>;
}
```
Everything else (chat, files, ports, terminal) goes through sandboxd, never through the provider. That is what makes managed VMs and BYO hosts behave the same.

---

## 6. Harness layer (pi by default, others selectable)

### 6.1 Selection policy
- The superadmin sets the **platform default harness**, e.g. `pi`.
- An org admin may override it for the org, e.g. `claude-code`.
- Per project: the harness is the org default. Users can only pick a different one if the org enables `allowProjectHarnessChoice`; admins can always change it, which takes effect on the next session.
- The same policy shape applies to the **model allowlist** and the **default model**.

### 6.2 The `HarnessAdapter` interface (inside sandboxd)

```ts
interface HarnessAdapter {
  id: "pi" | "claude-code" | "codex" | "opencode";
  check(): Promise<{ installed: boolean; version: string }>;
  configure(cfg: HarnessConfig): Promise<void>;       // writes harness-native config files, see 6.3
  applyBundles(b: ResolvedBundles): Promise<void>;     // see 6.4
  createSession(opts: { cwd: string; model: string }): Promise<string>;
  prompt(sessionId: string, input: { text: string; attachments?: Attachment[] }): Promise<void>;
  abort(sessionId: string): Promise<void>;
  events(sessionId: string): AsyncIterable<HarnessEvent>;
  history(sessionId: string): Promise<HarnessEvent[]>;
}

type HarnessEvent =
  | { type: "message.start"; role: "assistant" }
  | { type: "text.delta"; text: string }
  | { type: "tool.start"; id: string; name: string; summary: string }   // summary is user-safe
  | { type: "tool.end"; id: string; ok: boolean; summary: string }
  | { type: "question"; id: string; text: string; options?: string[] } // must be answerable from the chat UI
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: "error"; message: string; retryable: boolean }
  | { type: "settled" };                                                // no more automatic work will follow

type HarnessConfig = {
  gatewayBaseUrl: string;     // e.g. https://gw.<domain>
  projectKey: string;         // LiteLLM virtual key for this project, the only credential in the sandbox
  models: CatalogModel[];     // allowed models with their API family
  defaultModel: string;
  instructions: string;       // merged system/AGENTS instructions from bundles
};
type CatalogModel = { id: string; label: string; api: "anthropic-messages" | "openai-responses" | "openai-completions" };
```

### 6.3 How each harness talks to the gateway

Every harness points at **LiteLLM** with the **project virtual key**. LiteLLM serves `/v1/messages` (Anthropic shape), `/v1/responses` and `/v1/chat/completions` (OpenAI shapes), and translates between providers. That is what makes "any model in any harness" possible.

| Harness | How sandboxd drives it | How it is pointed at the gateway (**VERIFY** each against the pinned version with a contract test) |
|---|---|---|
| **pi** (default) | In-process **pi SDK** (`createAgentSession`, event subscription). Use RPC mode (`pi --mode rpc`, strict LF-only JSONL framing; Node `readline` is not compliant) only if process isolation is needed | Generate `~/.pi/agent/models.json` with one provider per API family, all with `baseUrl` = gateway and `apiKey` = `$PROJECT_KEY`. Supported `api` values include `anthropic-messages`, `openai-responses`, `openai-completions` and `google-generative-ai`. List exactly the allowed models so pi's picker matches the allowlist. Built-in providers can instead be routed by setting only their `baseUrl`. |
| **Claude Code** | Claude Agent SDK (TS) in-process, or `claude -p --output-format stream-json --input-format stream-json` | Env: `ANTHROPIC_BASE_URL` = gateway, `ANTHROPIC_AUTH_TOKEN` = project key, `ANTHROPIC_MODEL` = chosen model. The gateway must expose `/v1/messages` and `/v1/messages/count_tokens` and forward the `anthropic-beta` / `anthropic-version` headers. Non-Anthropic models work through LiteLLM translation, but tool-use fidelity varies: mark them "experimental" in the catalog. |
| **Codex** | `codex app-server` (JSON-RPC) or `codex exec --json` | `~/.codex/config.toml`: `[model_providers.platform]` with `base_url` = gateway `/v1`, `env_key = "PROJECT_KEY"`, `wire_api = "responses"`, and `model_provider = "platform"`. Don't reuse the reserved provider IDs (`openai`, `ollama`, `lmstudio`). |
| **OpenCode** | `opencode serve` HTTP API, with a password | Provider `@ai-sdk/openai-compatible` with `baseURL` = gateway, written via **`PATCH /global/config`**. Prototype lesson: `PATCH /config` writes a project file OpenCode never reloads. |

pi `models.json` sketch (generated by sandboxd from `HarnessConfig`):

```json
{
  "providers": {
    "platform-anthropic": { "baseUrl": "https://gw.example.com", "api": "anthropic-messages", "apiKey": "$PROJECT_KEY",
                            "models": [{ "id": "claude-sonnet-5-5" }] },
    "platform-openai":    { "baseUrl": "https://gw.example.com/v1", "api": "openai-responses", "apiKey": "$PROJECT_KEY",
                            "models": [{ "id": "gpt-5" }] },
    "platform-compat":    { "baseUrl": "https://gw.example.com/v1", "api": "openai-completions", "apiKey": "$PROJECT_KEY",
                            "models": [{ "id": "groq/openai/gpt-oss-120b" }, { "id": "gemini/gemini-2.5-pro" }] }
  }
}
```
**VERIFY:** the exact `baseUrl` suffix each pi API family expects (whether the SDK appends `/v1/messages` itself). Lock this down with one contract test per API family.

**Contract test matrix (CI, nightly, against a real LiteLLM with a cheap model per family).** For each harness × API family:
1. A simple reply.
2. One tool call: write a file, run `ls`.
3. Abort mid-stream.
4. Usage reported.
5. Error surfaced: bad model, exhausted budget.

A harness × family pair that fails is hidden from the catalog for that harness.

### 6.4 Bundles: instructions, skills, plugins, MCP (admin-managed, applied at boot)
A **bundle** is a versioned unit an admin uploads or links (git URL + ref, or zip). It is assigned at **platform → org → project** scope. Lower scopes add to, or override by name, the higher ones.

```yaml
# bundle.yaml
name: acme-standards
version: 1.4.0
instructions: instructions.md          # merged into AGENTS.md / CLAUDE.md / system prompt
skills: [skills/]                      # Agent Skills format: <dir>/SKILL.md (+ scripts/, references/)
mcp:                                   # MCP servers made available to the harness
  - name: jira
    command: npx
    args: ["-y", "@acme/jira-mcp"]
    env: { JIRA_TOKEN: "secret://org/jira-token" }   # resolved server-side, injected at apply time
harness:
  pi: { packages: ["npm:@acme/pi-tools@1.2.0"] }
  claude-code: { plugins: ["acme-plugin@1.0.0"] }
setup: setup.sh                        # optional, idempotent, runs as root after bundles are placed
```

sandboxd's `applyBundles` maps one bundle onto each harness's native layout. **VERIFY** the paths per pinned version:

| Bundle part | pi | Claude Code | Codex | OpenCode |
|---|---|---|---|---|
| instructions | `AGENTS.md` in `/workspace` (+ global agent dir) | `CLAUDE.md` (project + `~/.claude/CLAUDE.md`) | `AGENTS.md` | `AGENTS.md` |
| skills | `~/.pi/agent/skills/` or `settings.json` `skills` | `~/.claude/skills/` | Codex skills dir | OpenCode skills/agents dir |
| MCP | pi `builtin:mcp` config | `.mcp.json` / `~/.claude.json` | `config.toml` `[mcp_servers]` | `opencode.json` `mcp` |
| plugins | pi packages (`settings.json` `packages`) | Claude Code plugins | n/a | OpenCode plugins |

Other rules:
- Bundles apply on first boot and again whenever an assignment changes. The `bundle.apply` RPC is idempotent. Admins see an "applied version" per project.
- Bundle sources are reviewed code. Only admins can add them, every change is audited, and secrets are referenced (`secret://…`), never inlined.

---

## 7. LLM gateway, keys, BYOK and credits

### 7.1 Topology
- LiteLLM runs privately. Only the control plane and the sandbox network can reach it, and only through an HTTPS ingress that requires a virtual key.
- **Each project gets one LiteLLM virtual key**, created by the gateway-sync worker. It carries the allowed models, `max_budget`, `budget_duration`, rpm/tpm limits and metadata (`org_id`, `project_id`). Rotate it on demand and on sandbox rebuild. Revoke it when the project is deleted or stopped for good.
- Org → LiteLLM **team** (an org-wide budget pool). Project key → belongs to the team.
- Provider credentials (Anthropic, OpenAI, Gemini, Bedrock, Vertex, OpenRouter, Groq, local vLLM/Ollama, …) are configured **by the superadmin** as LiteLLM model deployments. Each model in the catalog has a price (LiteLLM's price map, or an admin override).

### 7.2 How a project gets model access (in order of precedence)
1. **BYOK (project or user key).** A user pastes their own provider key. The control plane stores it (envelope-encrypted) and registers it with LiteLLM as a **team/project-scoped model deployment**, so it is only usable by that project's key. Spend is tracked but not charged against credits (optionally a platform fee).
2. **Org key.** The org admin adds a provider key for the whole org, registered as a team-scoped deployment.
3. **Platform credits.** The project uses the superadmin's shared deployments, and spend is debited from the org's credit balance (§7.4).
4. If none apply, chat is blocked with a clear call to action: "Add your key" or "Request access". The request lands in the admin queue.

The key never enters the sandbox in any of these cases. The sandbox only ever holds its project virtual key.

### 7.3 Claude subscription tokens (important)
Anthropic does not allow consumer-plan (Pro/Max) OAuth tokens to be used in third-party harnesses or products. Anthropic advises building on **API keys**. Therefore:
- The "Connect Claude" flow accepts an **Anthropic API key** (Console) and treats it as BYOK.
- Do not build a flow that collects users' Claude subscription OAuth / `setup-token` credentials to run on our platform. If the business still wants it, it ships behind a superadmin feature flag that is **off** by default, only after legal review, and only for the individual's own sandbox.
- Re-check Anthropic's current terms before launch; this area has changed several times in 2026.

### 7.4 Credits and spend
- **Ledger** tables (`wallet`, `ledger_entry`) are append-only, in USD micro-units, with idempotency keys.
- Credits are granted by the superadmin (or later via payments) to an org wallet. The org admin may sub-allocate per project.
- The spend-sync worker pulls per-key spend from LiteLLM every minute and writes ledger debits. The gateway-sync worker sets each LiteLLM team/key `max_budget` = remaining balance, so LiteLLM itself blocks requests at zero. There is no race window where the platform overspends by more than one in-flight request.
- Alerts go out at 80% and 100% (webhook + email + banner in the UI).
- BYOK spend is recorded for visibility, with `billable = false`.

---

## 8. Data model (minimum)

```
users(id, email, name, status, created_at)
orgs(id, name, settings jsonb)                       -- allowProjectHarnessChoice, defaults, idle policy
memberships(org_id, user_id, role)                   -- admin | member
platform_admins(user_id)                             -- superadmin
grants(user_id, project_id, capability)              -- 'terminal'
projects(id, org_id, owner_id, name, harness, model, image_version,
         sandbox_id, status, status_detail, created_at)
sandboxes(id, provider, provider_ref, host_id, ip_private, size, state,
          enrolled_at, cert_fingerprint, last_seen_at)
byo_hosts(id, org_id, address, port, ssh_user, ssh_key_ref, host_key_fp, preflight jsonb, state)
images(id, version, status, built_at, manifest jsonb)
credentials(id, scope, scope_id, provider, secret_ref, created_by)   -- scope: platform|org|project|user
gateway_keys(project_id, litellm_key_id, models[], max_budget, rotated_at)
bundles(id, name, scope, scope_id) / bundle_versions(id, bundle_id, version, source, digest, manifest)
bundle_assignments(bundle_id, version, scope, scope_id) / bundle_applied(project_id, bundle_version_id, applied_at)
wallets(org_id, balance_micros) / ledger_entries(id, wallet_id, project_id, kind, amount_micros, ref, idem_key, at)
access_requests(id, org_id, user_id, project_id, kind, status, decided_by)
chat_sessions(id, project_id, harness_session_id) / chat_events(session_id, seq, event jsonb, at)  -- mirror for UI history
audit_events(id, actor_id, action, target, ip, meta jsonb, at)       -- append-only
```

---

## 9. Security requirements

1. **Isolation.** One project = one VM (or one dedicated BYO host). The harness runs as root inside the VM, and the VM is the boundary.
2. **Network policy** (Incus network ACLs plus a host firewall):
   - Ingress to sandboxes: **deny all**. sandboxd connects out, and preview traffic comes through the tunnel or the proxy only.
   - Sandbox → sandbox: **deny**.
   - Sandbox → host / control-plane internals / cloud metadata (169.254.169.254) / RFC1918: **deny**, except the gateway ingress and the sandboxd endpoint.
   - Sandbox → internet: allowed by default (installs need it). An org policy can restrict it to an allowlist.
   - Docker on the same host: insert `DOCKER-USER` rules so Docker doesn't break VM forwarding.
3. **Secrets.** Provider keys exist only in the control plane (encrypted) and in LiteLLM. The sandbox holds only its scoped, budget-capped, revocable project key. Secrets referenced by bundles are resolved at apply time and are visible to the admin only as references.
4. **Terminal and exec.** Allowed only with the `terminal` grant (or admin role). Every session is recorded (asciinema-format stream, kept per retention policy) and audited with actor, project, start/end.
5. **Auth.** Secure, HttpOnly, SameSite cookies; CSRF protection on state-changing requests; optional MFA for admins; SSO for orgs; login rate limiting and lockout.
6. **Preview isolation.** A separate domain, scoped short-lived cookies, never console cookies. A strict CSP on the console.
7. **Supply chain.** Pinned versions in `versions.lock`, checksums for downloaded installers, image SBOM, signed images.
8. **Audit everything administrative:** role changes, grants, credentials, bundles, image publishes, terminal sessions, budget changes.
9. **Data.** Tenant ID on every query (enforced in the repository layer, plus Postgres RLS if feasible). Backups for both Postgres instances. A documented, tested restore.

---

## 10. Milestones (build in this order)

Each milestone ends with its acceptance tests green in CI.

| # | Milestone | Done when |
|---|---|---|
| M0 | Repo skeleton: monorepo (`apps/api`, `apps/web`, `apps/admin`, `packages/sandboxd`, `packages/shared`), CI, lint, typecheck, Docker Compose (Postgres, LiteLLM + its Postgres, API, web) | `docker compose up` gives a working login page; CI green |
| M1 | Auth, orgs, roles, `authz` module, audit log, admin bootstrap from env (`ADMIN_EMAIL`/`ADMIN_PASSWORD`, created or reset on start) | Role matrix (§2) covered by table-driven tests |
| M2 | Image pipeline + `provision.sh` + Incus `SandboxProvider` + warm pool | New VM from a warm pool reaches `enrolled` in under 10s; from a cold image in under 60s |
| M3 | sandboxd: enrollment, mTLS tunnel, health, progress, ports, fs, pty | Tunnel survives control-plane restart; terminal and files work only with the grant |
| M4 | Gateway: LiteLLM keys, catalog, allowlist, BYOK registration, org keys | A project key can call only allowed models; a revoked key fails within 5s |
| M5 | Harness adapters: **pi first**, then Claude Code, Codex, OpenCode. Normalized events. Contract test matrix | pi passes all 5 contract cases on every API family in the catalog |
| M6 | User web app: onboarding, chat streaming, friendly tool summaries, questions answerable, preview proxy | E2E: sign up → project → "build a Vite app on :5173" → preview shows it |
| M7 | Bundles: upload, assign, apply per harness, admin view of applied versions | A skill added at org scope appears in every org project's harness after re-apply |
| M8 | Credits: wallet, ledger, spend sync, budget enforcement, alerts, access requests | Spend stops at zero balance; ledger reconciles with LiteLLM to the cent |
| M9 | BYO SSH hosts: preflight, bootstrap, enrollment, trust-model UI | A fresh Ubuntu 24.04 host goes from SSH details to a ready project in under 10 minutes, without manual steps |
| M10 | Hardening: network policy tests, rate limits, backups and restore drill, OTel dashboards, load test | §11 security and load suites pass |

---

## 11. Testing strategy

- **Unit tests:** authz matrix, ledger math, config generators (pi `models.json`, Codex `config.toml`, Claude env), bundle merge rules.
- **Contract tests (§6.3):** real harness CLIs against a real LiteLLM. Run nightly and on version bumps.
- **Image tests**, run on every built image:
  - `docker run hello-world`
  - Every harness CLI reports its pinned version.
  - sandboxd starts.
  - Two clones get different machine-ids and IPs.
- **E2E (Playwright)** for the user and admin flows in §10. Use a real Incus in CI (a self-hosted runner with KVM).
- **Security suite**, run from inside a sandbox. Each of these must fail:
  - Reach another sandbox.
  - Reach the host or control-plane DB.
  - Reach the metadata IP.
  - Reach LiteLLM admin routes.
  - Use another project's key.

  From the API: a member must be refused terminal, files, exec and another org's project.
- **Load:** 50 concurrent chats streaming. Provisioning 20 projects at once with a pool of 5. Track p95 for "create → ready" and "message → first token".

---

## 12. Lessons from the prototype in this repo (don't repeat these)

1. Every VM installing Docker + the agent on first boot took over 3 minutes on a slow link. **Bake images and keep a warm pool.**
2. 1 GiB VMs got the agent OOM-killed once Docker was running. **Default to 2 GiB.**
3. OpenCode `PATCH /config` writes a project file it never reloads. Use `PATCH /global/config` (or write config before start).
4. UI status polls hung because a health check had a 15s timeout while Bun's idle timeout is 10s. **Keep health checks short (≤3s), and give long-lived streams their own timeouts.**
5. A UI cleanup ran after the new page registered its timers and killed the live refresh. **Tear down the old view before building the new one.** Prefer pushing events (SSE/WS) to polling.
6. Incus `admin init` can't auto-pick a subnet when Docker has used many ranges. **Configure the bridge subnet explicitly.**
7. Docker sets FORWARD to DROP. **Add `DOCKER-USER` accept rules for the sandbox bridge.**
8. Cloned images need `cloud-init clean --machine-id`, or every clone requests the same DHCP lease.
9. Model names go stale (e.g. Groq retired `llama-3.3-70b-versatile`). **Validate catalog models with a nightly ping; hide failing ones.**
10. Restarting a VM changes its IP. Never store IPs as identity; route by sandbox ID through the tunnel.

What carries over from the prototype: the layering (`db` / `core`+`authz` / `vm` provider / `harness` adapter / `server`), gateway-side key injection (keys never in the VM), the progress step model, and the split-view UI layout.

---

## 13. Decisions still open (ask the owner before M2)

1. Hosting: one beefy bare-metal host with Incus, or a cloud with nested virtualization? This decides warm-pool size and density.
2. Should sandboxes have open internet egress by default, or an allowlist?
3. Credits: manual grants only in v1, or a payments integration (e.g. Stripe) at M8?
4. Should chat history live only in the harness session files inside the VM, or also be mirrored to Postgres (recommended, for durability across rebuilds)?
5. BYO hosts: allow regular users to add them, or admins only?
