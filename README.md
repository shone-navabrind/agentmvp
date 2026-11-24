# Harness Cloud

A self-hosted platform where a workspace holds many projects, each project owns one
sandbox, and many agent sessions run concurrently inside it — with a board, a durable
flow runtime, triggers, plugins and metered model spend built on one event log.

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the design, the kernel, the extension
  model, the build order, and where it goes wrong
- **[docs/STATUS.md](docs/STATUS.md)** — what is built, what is not, and why
- **[docs/anatomy.html](docs/anatomy.html)** — the system anatomy, with diagrams
- **[docs/screenshots/](docs/screenshots/)** — the UI, captured against the running stack

```bash
npm install
npm test        # 239 tests, 11 packages, no external services
npm start       # http://localhost:8787
```

## Layout

```
packages/kernel     event log · projections · durable step runtime · authz · secrets · outbox
packages/blueprints pre-baked environments; catalog and AI-synthesised stacks, one pipeline
packages/harness    normalized harness events, Claude Code adapter
packages/flow       typed-edge graph runtime, guards, human-in-the-loop
packages/compute    ComputeDriver, host splitting, capability negotiation, warm pool
packages/sandbox    git worktrees per session, cgroups, ports, admission control
packages/board      task projection, approval inbox, automations
packages/triggers   event · cron · webhook · repo, with concurrency policy and a DLQ
packages/plugins    manifest, capability enforcement, circuit breaker
packages/billing    append-only ledger in micro-units, budget enforcement
apps/api            read API + the integration test over every package at once
apps/web            three-pane UI served by the API
```

The one idea holding it together: board, hooks, triggers, recurring jobs, audit, outbound
integrations, flow recovery and chat history are the same two mechanisms seen from
different angles — an append-only **event log** and a durable **step runtime**.
