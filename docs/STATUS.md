# Build status

Against the milestones in `ARCHITECTURE.md` §16. **267 tests, 13 packages, 0 failures**,
no external services — PGlite gives every test a real Postgres 17 in-process.

```bash
npm install
npm test        # all packages
npm run typecheck
npm start       # http://localhost:8787
npm run shots   # re-capture docs/screenshots/
```

## What is built and tested

| # | Milestone | Package | Tests | State |
|---|---|---|---|---|
| K1 | Kernel: event log, projections, step runtime, authz, secrets, outbox | `@harness/kernel` | 60 | **done** |
| — | **Blueprints**: schema, validator, compiler, catalog, AI synthesis | `@harness/blueprints` | 36 | **done** |
| K5 | **Harness adapters**: normalized events + Claude Code | `@harness/harness` | 24 | **partial** (Claude Code only) |
| K2 | Compute drivers, host splitting, capability negotiation, warm pool | `@harness/compute` | 20 | **done** (Incus argv only, see below) |
| K3 | Multi-session: worktrees, cgroups, ports, admission control | `@harness/sandbox` | 13 | **partial** (no sandboxd daemon) |
| K7 | Flow graph runtime: typed edges, guards, human-in-the-loop | `@harness/flow` | 19 | **done** |
| K8 | Triggers: event, cron, webhook, repo; concurrency, DLQ | `@harness/triggers` | 16 | **done** |
| K9 | Board: projection, agent assignment, approval inbox, automations | `@harness/board` | 9 | **done** |
| K10 | Plugins: manifest, capability enforcement, circuit breaker | `@harness/plugins` | 18 | **done** |
| K12 | Credits: ledger, budget enforcement, spend sync, alerts | `@harness/billing` | 12 | **done** |
| — | Full-stack integration + accessibility gate + web UI | `@harness/api` | 12 | **done** |

### The two K1 acceptance tests, by name in the suite

- `K1 ACCEPTANCE: a run killed mid-flight resumes and produces identical output`
- `K1 ACCEPTANCE: replay rebuilds a projection byte-identically`

## What is NOT built, and why

Honest accounting. Nothing below is stubbed out and claimed as working.

| Gap | Reason | What exists instead |
|---|---|---|
| **Real Incus VMs** | No KVM or Incus in this container | `IncusDriver` is written in full; its `incusArgv` command construction is unit-tested (VM not container, limits, cloud-init enrollment token, bounded stop timeout). Execution needs a KVM runner. |
| **sandboxd** | Needs a real VM to run in | The sandbox protocol is specified in `ARCHITECTURE.md` §2.5; `WorktreeManager` and `SessionManager` are the pieces that would run inside it, and both are tested against real git. |
| **LiteLLM gateway (K4)** | No provider keys, no LiteLLM here | `GatewayAdmin` is the interface; `BudgetEnforcer` is tested against a fake that records budget pushes and spend pulls. |
| **Harness adapters (K5)** | pi / Claude Code / Codex CLIs not installed | `HarnessAdapter` and the normalized event shape are specified; `agentNode` is the flow-side contract. |
| **BYO SSH hosts (K9 in v1)** | Deferred by `ARCHITECTURE.md` §16 to K13 | — |
| **Auth, SSO, sessions (K0)** | Not started | `authz` (the capability layer that sits above it) is complete and table-driven. |
| **Firecracker / OCI drivers** | Deferred to K13 | The `ComputeDriver` interface and capability negotiation make them additive. |

The web app is a working UI. By default it boots empty and persisted (Postgres via
`DATABASE_URL`, or PGlite on disk): you create projects, sessions and board tasks, choose a
blueprint, and chat with a real Claude Code process running in the session's git worktree
when `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` is set. Not yet driven from the UI:
starting flows, creating triggers, installing plugins, the terminal, and blueprint
provisioning (D10). Agents run in the app container itself, not an isolated VM.
`HARNESS_DEMO=1` serves the original read-only scripted scenario.

## Bugs the tests and screenshots caught in this code

Worth recording, because each was a real defect rather than a test problem:

1. **A failed non-idempotent step was as ambiguous as an interrupted one.** The guard only
   checked for `started`, so a payment step that threw *after* the provider received the
   request would have been retried and double-charged.
2. **Persisted errors dropped their `code` and `details`,** leaving operators a bare string.
3. **Deterministic errors burned the whole retry allowance.** A tripped guard or a schema
   violation fails identically on every attempt; `KernelError.retryable` now ends the run
   at once.
4. **A suspended step was recorded as `failed`.** Caught by looking at the Flows screenshot:
   a paused run rendered red with a `SUSPEND_RUN` error. Waiting on a person is not a
   failure — it is now its own step state.
5. **The three-pane layout overflowed below ~760px**, with the rails covering the content.
   Caught when Playwright could not click a tab at phone width.

## Screenshots

In `docs/screenshots/`, captured by `npm run shots` against the running stack — every number
in them comes from the packages, not from fixtures in the page.

| File | Shows |
|---|---|
| `01-session-chat.png` | Session view, friendly tool summaries, project-status rail |
| `02-board.png` | Kanban projection; blocked cards auto-raised by paused runs |
| `03-flows.png` | Run timelines, step memoisation, the approval gate |
| `04-triggers.png` | Event/cron/webhook triggers with concurrency policy |
| `05-repos-worktrees.png` | Multi-repo bare clones and per-session worktrees |
| `06-terminal.png` | Capability-gated terminal tab |
| `07-plugins.png` | Trust, declared capabilities, the circuit-broken plugin |
| `08-credits.png` | Ledger, BYOK exclusion, gateway cap, zero drift |
| `09-second-session.png` | Switching sessions; per-session branch and ports |
| `10-narrow.png` | Phone width: columns stack, rails collapse |
