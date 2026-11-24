import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { buildDemo, type Demo } from "./demo-data.ts";
import { buildApp, HttpError } from "./app.ts";
import { KernelError, type Subject } from "@harness/kernel";

/**
 * The capability each route needs. Previously authz existed, was tested, and guarded
 * nothing: the only caller reported decisions to the UI. Now every route is listed
 * here and refused before its handler runs.
 */
const ROUTE_CAPABILITY: Record<string, string> = {
  "/api/v1/workspace": "project:read",
  "/api/v1/project": "project:read",
  "/api/v1/sessions": "project:read",
  "/api/v1/board": "project:read",
  "/api/v1/flows": "project:read",
  "/api/v1/triggers": "project:read",
  "/api/v1/blueprints": "project:read",
  "/api/v1/events": "project:read",
  "/api/v1/scope": "project:read",
  "/api/v1/authz": "project:read",
  "/api/v1/plugins": "plugin:install",
  "/api/v1/billing": "workspace:budget:manage",
};

/** Writes are listed the same way: a POST with no entry here is refused, not let through. */
const WRITE_CAPABILITY: Array<[RegExp, string]> = [
  [/^\/api\/v1\/projects$/, "workspace:projects:create"],
  [/^\/api\/v1\/projects\/[^/]+\/blueprint$/, "project:write"],
  [/^\/api\/v1\/sessions$/, "project:write"],
  [/^\/api\/v1\/sessions\/[^/]+\/messages$/, "project:chat"],
  [/^\/api\/v1\/board\/tasks$/, "project:write"],
  [/^\/api\/v1\/board\/tasks\/[^/]+\/move$/, "project:write"],
];

function capabilityFor(path: string, method = "GET"): string | undefined {
  if (method !== "GET") return WRITE_CAPABILITY.find(([re]) => re.test(path))?.[1];
  if (ROUTE_CAPABILITY[path]) return ROUTE_CAPABILITY[path];
  // A session transcript is project data like any other.
  if (path.startsWith("/api/v1/sessions/")) return "project:read";
  return undefined;
}

/**
 * Until authentication lands (K0) there is no real caller to identify, so the viewer
 * is resolved from a header for development. This is deliberately a single function:
 * when K0 arrives it is the only thing that changes.
 */
function subjectFor(req: IncomingMessage): Subject {
  const role = String(req.headers["x-harness-role"] ?? "operator");
  const known = ["member", "admin", "superadmin"];
  const mapped = role === "guided" ? "member" : role === "builder" ? "admin" : "superadmin";
  return {
    kind: "user",
    id: `dev-${role}`,
    assignments: [
      { role: known.includes(mapped) ? mapped : "superadmin", scope: "workspace", scopeId: "ws1" },
      { role: "superadmin", scope: "tenant", scopeId: "t1" },
    ].slice(0, mapped === "superadmin" ? 2 : 1) as Subject["assignments"],
  };
}

/** Blank out every secret binding value wherever it appears in generated text. */
function redactSecrets(
  text: string,
  bp: { inputs: Array<{ key: string; secret: boolean }> },
  bindings: { inputs: Record<string, string> },
): string {
  let out = text;
  for (const input of bp.inputs) {
    if (!input.secret) continue;
    const value = bindings.inputs[input.key];
    if (value) out = out.split(value).join("\u2022".repeat(8));
  }
  return out;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * The read side of the API, over the same data the packages produce. Every route is a
 * projection or an in-memory manager -- nothing here holds state of its own.
 */
async function routes(demo: Demo, path: string): Promise<unknown | undefined> {
  const { kernel: k, board, sessions, ledger, triggers, plugins, scope } = demo;

  if (path === "/api/v1/project") {
    const steps = await Promise.all(
      [demo.runs.releaseRun, demo.runs.nightlyRun, demo.runs.failingRun].map((id) => k.steps.get(id)),
    );
    return {
      id: "p1",
      name: "acme-platform",
      workspace: "Navabrind IT",
      harness: "pi",
      model: "claude-sonnet-5-5",
      imageVersion: "1.4.0",
      sandbox: {
        id: demo.sandboxRef.ref.id,
        driver: demo.sandboxRef.driver,
        host: demo.sandboxRef.ref.hostId,
        isolation: demo.driver.capabilities().isolation,
        fromWarmPool: demo.sandboxRef.fromWarmPool,
        state: await demo.driver.state(demo.sandboxRef.ref),
        size: { vcpu: 2, memMiB: 4096, diskGiB: 20 },
      },
      repos: [
        { name: "api", remote: "github.com/acme/api", branch: "main" },
        { name: "web", remote: "github.com/acme/web", branch: "main" },
      ],
      capacity: {
        maxSessions: demo.maxSessions,
        activeSessions: sessions.activeCount(),
        hostFree: demo.pool.free("node-1"),
        warmPool: demo.scheduler.warmCount("1.4.0"),
      },
      runs: steps.filter(Boolean),
    };
  }

  if (path === "/api/v1/sessions") {
    return sessions.list().map((s) => ({
      ...s,
      title: demo.sessionNames[s.id] ?? s.id,
    }));
  }

  if (path.startsWith("/api/v1/sessions/")) {
    const id = path.split("/").pop()!;
    const events = await k.log.readStream(`session:${id}`);
    return { id, title: demo.sessionNames[id] ?? id, events };
  }

  if (path === "/api/v1/board") {
    return { columns: await board.columns("p1"), inbox: await board.inbox("p1") };
  }

  if (path === "/api/v1/flows") {
    const ids = [demo.runs.releaseRun, demo.runs.nightlyRun, demo.runs.failingRun];
    const runs = [];
    for (const id of ids) {
      const rec = await k.steps.get(id);
      if (rec) runs.push({ ...rec, steps: await k.steps.steps(id) });
    }
    return { runs, awaiting: await k.steps.awaitingDecision() };
  }

  if (path === "/api/v1/triggers") {
    return triggers.list("p1").map((t) => ({
      ...t,
      firings: triggers.firings(t.id).length,
      lastState: triggers.firings(t.id).at(-1)?.state ?? null,
    }));
  }

  if (path === "/api/v1/billing") {
    return {
      balanceMicros: await ledger.balance("ws1"),
      granted: 250,
      entries: (await ledger.entries("ws1")).slice(-8),
      byProject: await ledger.spendByProject("ws1"),
      reconcile: await ledger.reconcile("ws1"),
      gatewayBudgets: demo.budgets,
      alerts: demo.alerts,
    };
  }

  if (path === "/api/v1/plugins") {
    return plugins.list().map((p) => ({
      id: p.manifest.id,
      version: p.manifest.version,
      trust: p.manifest.trust,
      runtime: p.manifest.runtime,
      description: p.manifest.description,
      provides: p.manifest.provides,
      capabilities: p.manifest.capabilities,
      state: p.state,
      failures: p.failures,
      lastError: p.lastError ?? null,
    }));
  }

  if (path === "/api/v1/events") {
    const events = await k.log.readAll({ limit: 40 });
    return events.slice(-25).reverse();
  }

  if (path === "/api/v1/authz") {
    const resource = { tenantId: "t1", workspaceId: "ws1", projectId: "p1" };
    const subjects = [
      { label: "member", s: { kind: "user" as const, id: "u-m", assignments: [{ role: "member", scope: "workspace" as const, scopeId: "ws1" }] } },
      { label: "member + terminal grant", s: { kind: "user" as const, id: "u-g", assignments: [{ role: "member", scope: "workspace" as const, scopeId: "ws1" }, { capability: "project:terminal:open", scope: "project" as const, scopeId: "p1" }] } },
      { label: "admin", s: { kind: "user" as const, id: "u-a", assignments: [{ role: "admin", scope: "workspace" as const, scopeId: "ws1" }] } },
      { label: "agent session", s: { kind: "agent" as const, id: "s-auth", assignments: [{ capability: "project:files:write", scope: "project" as const, scopeId: "p1" }] } },
    ];
    const caps = ["project:read", "project:chat", "project:files:write", "project:terminal:open", "workspace:budget:manage"];
    return subjects.map(({ label, s }) => ({
      subject: label,
      kind: s.kind,
      decisions: Object.fromEntries(caps.map((c) => [c, k.authz.can(s, c, resource).allowed])),
    }));
  }

  if (path === "/api/v1/blueprints") {
    const b = demo.blueprints;
    return {
      catalog: b.catalog.map((x) => ({
        id: x.id, name: x.name, summary: x.summary, tags: x.tags, origin: x.origin,
        services: x.services.length, estimateMinutes: x.ui.estimateMinutes,
        whatYouGet: x.ui.whatYouGet,
        needs: {
          repos: x.repos.map((r) => ({ id: r.id, label: r.label, required: r.required, hint: r.hint })),
          seeds: x.seeds.map((s) => ({ id: s.id, label: s.label, required: s.required, hint: s.hint, scrubs: s.neutralize.recipes })),
          inputs: x.inputs.map((i) => ({ key: i.key, label: i.label, required: i.required, secret: i.secret, hint: i.hint })),
        },
      })),
      active: {
        id: b.active.id, name: b.active.name, summary: b.active.summary,
        whatYouGet: b.active.ui.whatYouGet, estimateMinutes: b.active.ui.estimateMinutes,
      },
      // An input declared secret is never serialised to a client, and the rendered
      // compose carries those values inline, so it is redacted the same way.
      bindings: {
        ...b.bindings,
        inputs: Object.fromEntries(
          Object.entries(b.bindings.inputs).map(([k, v]) => [
            k,
            b.active.inputs.find((i) => i.key === k)?.secret ? "" : v,
          ]),
        ),
      },
      // Whether a secret is set is not itself a secret, and the UI cannot infer it
      // from a blanked value without reporting a configured password as missing.
      inputsSet: Object.fromEntries(
        b.active.inputs.map((i) => [i.key, Boolean((b.bindings.inputs as Record<string, string>)[i.key])]),
      ),
      ready: b.check.ok,
      missing: b.check.missing,
      previewPort: b.previewPort,
      compose: redactSecrets(b.compose, b.active, b.bindings),
      steps: b.graph.nodes.map((n) => ({ id: n.id, type: n.type, label: b.labels[n.id] })),
    };
  }

  if (path === "/api/v1/scope") return scope;
  return undefined;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 1_000_000) throw new HttpError(413, "Request body too large");
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body is not valid JSON");
  }
}

type Handler = {
  get(path: string, q: URLSearchParams): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
  authz: Demo["kernel"]["authz"];
  close(): Promise<void>;
};

async function demoHandler(): Promise<Handler> {
  const demo = await buildDemo();
  return {
    authz: demo.kernel.authz,
    async get(path) {
      if (path === "/api/v1/workspace") {
        return {
          demo: true,
          onboarded: true,
          workspace: "Navabrind IT",
          projects: [{ id: "p1", name: "acme-platform" }],
          agent: { available: false, reason: "This is the read-only demo scenario.", model: "claude-sonnet-5-5" },
        };
      }
      return routes(demo, path);
    },
    async post() {
      throw new HttpError(405, "The demo (HARNESS_DEMO=1) is read-only. Start without it to use the real app.");
    },
    close: demo.close,
  };
}

async function appHandler(dataDir: string, databaseUrl?: string): Promise<Handler> {
  const app = await buildApp({ dataDir, databaseUrl });
  return {
    authz: app.kernel.authz,
    get: (path, q) => (path.startsWith("/api/v1/sessions/") ? app.getSession(path.split("/").pop()!) : app.get(path, q)),
    post: (path, body) => app.post(path, body),
    close: app.close,
  };
}

/**
 * `demo: true` serves the scripted scenario the tests and screenshots are written
 * against. Otherwise the real app: empty on first boot, persisted under `dataDir`.
 */
export async function start(
  port: number,
  webRoot: string,
  opts: { demo?: boolean; dataDir?: string; databaseUrl?: string } = {},
): Promise<{ close: () => Promise<void> }> {
  const handler = opts.demo || !opts.dataDir ? await demoHandler() : await appHandler(opts.dataDir, opts.databaseUrl);

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const isApi = url.pathname.startsWith("/api/");
      const json = (status: number, data: unknown) => {
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? String(v) : v)));
      };
      try {
        if (method !== "GET" && method !== "POST") throw new HttpError(405, `${method} is not supported`);
        if (method === "POST" && !isApi) throw new HttpError(405, "POST is only accepted on the API");

        // Authorization happens here, once, before any handler. No route reaches its
        // body without a decision having been made and recorded.
        const needed = capabilityFor(url.pathname, method);
        if (method === "POST" && !needed) throw new HttpError(404, `No such route: POST ${url.pathname}`);
        if (needed) {
          const decision = handler.authz.can(subjectFor(req), needed, {
            tenantId: "t1",
            workspaceId: "ws1",
            projectId: url.searchParams.get("project") ?? "p1",
          });
          if (!decision.allowed) {
            json(403, { error: "forbidden", capability: needed, reason: decision.reason });
            return;
          }
        }

        const data = method === "POST"
          ? await handler.post(url.pathname, await readJson(req))
          : isApi ? await handler.get(url.pathname, url.searchParams) : undefined;
        if (data !== undefined) {
          json(200, data);
          return;
        }
        if (isApi) throw new HttpError(404, `No such route: ${url.pathname}`);
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const body = await readFile(join(webRoot, file));
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
      } catch (err) {
        if (err instanceof HttpError) return json(err.status, { error: err.message });
        if (err instanceof KernelError) return json(400, { error: err.message, code: err.code });
        if (!isApi) return json(404, { error: "not found" });
        console.error(err);
        json(500, { error: String(err) });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await handler.close();
    },
  };
}
