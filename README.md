# Harness Cloud

A self-hosted platform where a workspace holds many projects, each project owns one
sandbox, and many agent sessions run concurrently inside it — with a board, a durable
flow runtime, triggers, plugins and metered model spend built on one event log.

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — the design, the kernel, the extension
  model, the build order, and where it goes wrong
- **[docs/STATUS.md](docs/STATUS.md)** — what is built, what is not, and why
- **[docs/anatomy.html](docs/anatomy.html)** — the system anatomy, with diagrams
- **[.egm/](.egm/)** — the Goldfish review reports: 155 findings from fresh-context reviewers
- **[docs/screenshots/](docs/screenshots/)** — the UI, captured against the running stack

## Run it

```bash
git clone https://github.com/shone-navabrind/agentmvp.git
cd agentmvp
docker compose up -d --build
```

Then open **http://localhost:8787**. The first screen asks you to create a project; nothing
is pre-filled. Projects, sessions, the board and spend are stored in Postgres (the `db`
service) and survive restarts. `docker compose down -v` wipes everything.

**Agent replies** need a model credential. Put one in a `.env` file next to
`compose.yaml` before `up`:

```bash
ANTHROPIC_API_KEY=sk-ant-...          # or CLAUDE_CODE_OAUTH_TOKEN=... (claude setup-token)
```

Without one the app works, but the chat box is disabled and says why. Each session runs
Claude Code on its own git branch of the project's repository (public `https://` repos).

**The old scripted demo** (a fake "acme-platform" company, read-only) is still there for the
tests and screenshots: `HARNESS_DEMO=1 docker compose up -d`.

Or let the script pick whichever of Docker and Node is available:

```bash
./setup.sh
```

| Command | What it does |
|---|---|
| `./setup.sh` | Docker if the daemon is up, otherwise Node |
| `./setup.sh docker` | force the container path |
| `./setup.sh local` | force the Node path |
| `./setup.sh test` | install and run the suite, start nothing |
| `./setup.sh down` | stop and remove the container |

Set `PORT` to use something other than 8787.

### Without Docker

Node 22 or newer, because the source ships as TypeScript and runs through node's type
stripping — there is no build step.

```bash
npm ci
npm test        # 267 tests, 13 packages, no external services
npm start       # http://localhost:8787
```

Without `DATABASE_URL`, `npm start` keeps its data in PGlite (an embedded Postgres) under
`.data/`, so nothing has to be installed. Set `DATABASE_URL=postgres://...` to use a real
Postgres instead, as the compose file does. The tests use in-memory PGlite; set
`TEST_DATABASE_URL` to an empty database to run the persistence test against Postgres.

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
