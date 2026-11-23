import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { buildDemo, type Demo } from "./demo-data.ts";

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

  if (path === "/api/v1/scope") return scope;
  return undefined;
}

export async function start(port: number, webRoot: string): Promise<{ close: () => Promise<void> }> {
  const demo = await buildDemo();

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      try {
        const data = await routes(demo, url.pathname);
        if (data !== undefined) {
          const body = JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? String(v) : v));
          res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
          res.end(body);
          return;
        }
        const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
        const body = await readFile(join(webRoot, file));
        res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
        res.end(body);
      } catch (err) {
        res.writeHead(url.pathname.startsWith("/api/") ? 500 : 404, {
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ error: String(err) }));
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  return {
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await demo.close();
    },
  };
}
