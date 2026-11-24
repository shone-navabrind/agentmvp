import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { ProcessHandle, Spawn } from "@harness/harness";
import { buildApp } from "./app.ts";
import { start } from "./server.ts";

/** A stand-in `claude` CLI: answers --version, and echoes each stream-json prompt. */
function fakeClaude(calls: string[][]): Spawn {
  return (argv) => {
    calls.push(argv);
    const lines: string[] = [];
    const waiters: Array<(v: IteratorResult<string>) => void> = [];
    let closed = false;
    const push = (l: string) => {
      const w = waiters.shift();
      if (w) w({ value: l, done: false });
      else lines.push(l);
    };
    const end = () => {
      closed = true;
      for (const w of waiters.splice(0)) w({ value: undefined, done: true });
    };
    let exit!: (n: number) => void;
    const exited = new Promise<number>((r) => (exit = r));
    if (argv[1] === "--version") {
      push("9.9.9 (Claude Code)");
      end();
      exit(0);
    }
    const handle: ProcessHandle = {
      write(line) {
        const text = JSON.parse(line).message.content[0].text as string;
        push(JSON.stringify({ type: "assistant", message: { content: [
          { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/w/README.md" } },
          { type: "text", text: `echo: ${text}` },
        ] } }));
        push(JSON.stringify({ type: "result", usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0.25 }));
      },
      wait: () => exited,
      kill: () => { end(); exit(0); },
      stdout: { [Symbol.asyncIterator]: () => ({
        next: () => lines.length ? Promise.resolve({ value: lines.shift()!, done: false })
          : closed ? Promise.resolve({ value: undefined, done: true })
          : new Promise((r) => waiters.push(r)),
      }) } as AsyncIterable<string>,
      stderr: (async function* () {})(),
    };
    return handle;
  };
}

const until = async (fn: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("condition never became true");
};

describe("real mode (no demo data)", () => {
  let dir: string;
  const prevKey = process.env.ANTHROPIC_API_KEY;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "hc-app-"));
    process.env.ANTHROPIC_API_KEY = "test-key";
  });
  after(async () => {
    if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = prevKey;
    await rm(dir, { recursive: true, force: true });
  });

  test("first boot is empty, writes persist, and a chat turn reaches the agent and back", async () => {
    const calls: string[][] = [];
    // TEST_DATABASE_URL (an empty database) runs this same test against real Postgres.
    const databaseUrl = process.env.TEST_DATABASE_URL;
    let app = await buildApp({ dataDir: dir, databaseUrl, spawn: fakeClaude(calls) });

    const ws = (await app.get("/api/v1/workspace", new URLSearchParams())) as { onboarded: boolean; projects: unknown[]; agent: { available: boolean } };
    assert.equal(ws.onboarded, false, "nothing exists before onboarding");
    assert.deepEqual(ws.projects, []);
    assert.equal(ws.agent.available, true);

    const p = (await app.post("/api/v1/projects", { name: "my-app" })) as { id: string };
    const q = new URLSearchParams({ project: p.id });
    assert.deepEqual(await app.get("/api/v1/sessions", q), [], "no seeded sessions");

    const s = (await app.post("/api/v1/sessions", { project: p.id, title: "First task" })) as { id: string };
    await app.post(`/api/v1/sessions/${s.id}/messages`, { text: "hello" });
    await until(async () => !((await app.getSession(s.id)) as { busy: boolean }).busy);

    const chat = (await app.getSession(s.id)) as { events: Array<{ type: string; payload: { text?: string; summary?: string } }> };
    const texts = chat.events.filter((e) => e.type === "session.text").map((e) => e.payload.text);
    assert.deepEqual(texts, ["hello", "echo: hello"]);
    assert.ok(chat.events.some((e) => e.type === "tool.ran" && e.payload.summary === "Read README.md"));

    const argv = calls.find((a) => a[1] === "-p")!;
    assert.ok(argv.includes("bypassPermissions"), "an unattended agent can actually edit files");
    const settings = JSON.parse(await readFile(join(dir, "agent-home", ".claude", "settings.json"), "utf8"));
    assert.ok(!("ANTHROPIC_BASE_URL" in settings.env), "no empty gateway URL shadows the user's key");

    const billing = (await app.get("/api/v1/billing", q)) as { entries: Array<{ billable: boolean; amount_micros: string }> };
    assert.equal(billing.entries.length, 1, "own-key spend is recorded");
    assert.equal(billing.entries[0].billable, false, "and never charged");

    const { taskId } = (await app.post("/api/v1/board/tasks", { project: p.id, title: "Ship it" })) as { taskId: string };
    await app.post(`/api/v1/board/tasks/${taskId}/move`, { to: "doing" });

    await app.close();
    app = await buildApp({ dataDir: dir, databaseUrl, spawn: fakeClaude([]) });

    const after = (await app.get("/api/v1/workspace", new URLSearchParams())) as { onboarded: boolean; projects: Array<{ name: string }> };
    assert.equal(after.onboarded, true, "survives a restart");
    assert.equal(after.projects[0].name, "my-app");
    const sessions = (await app.get("/api/v1/sessions", q)) as Array<{ title: string }>;
    assert.deepEqual(sessions.map((x) => x.title), ["First task"]);
    const board = (await app.get("/api/v1/board", q)) as { columns: Record<string, Array<{ title: string }>> };
    assert.equal(board.columns.doing?.[0]?.title, "Ship it");
    const again = (await app.getSession(s.id)) as { events: unknown[] };
    assert.equal(again.events.length, chat.events.length, "transcript survives too");
    await app.close();
  });

  test("bad input is a 400 that says what is wrong, not a 500", async () => {
    const app = await buildApp({ dataDir: join(dir, "b"), spawn: fakeClaude([]) });
    await assert.rejects(app.post("/api/v1/projects", { name: "" }), (e: { status: number }) => e.status === 400);
    await assert.rejects(app.post("/api/v1/projects", { name: "x", repoUrl: "file:///etc" }), (e: { status: number }) => e.status === 400);
    await assert.rejects(app.get("/api/v1/project", new URLSearchParams({ project: "nope" })), (e: { status: number }) => e.status === 404);
    await app.close();
  });
});

describe("real mode over HTTP", () => {
  const PORT = 8907;
  const BASE = `http://127.0.0.1:${PORT}`;
  const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "public");
  let dir: string;
  let server: { close: () => Promise<void> };
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "hc-http-"));
    server = await start(PORT, webRoot, { dataDir: dir });
  });
  after(async () => {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  });

  const post = (p: string, body: unknown, role?: string) =>
    fetch(BASE + p, {
      method: "POST",
      headers: { "content-type": "application/json", ...(role ? { "x-harness-role": role } : {}) },
      body: JSON.stringify(body),
    });

  test("the healthcheck route answers 200 before onboarding", async () => {
    const r = await fetch(BASE + "/api/v1/workspace");
    assert.equal(r.status, 200);
    assert.equal((await r.json()).onboarded, false);
  });

  test("onboarding, then project-scoped reads", async () => {
    const r = await post("/api/v1/projects", { name: "web" });
    assert.equal(r.status, 200);
    const { id } = await r.json();
    const project = await (await fetch(`${BASE}/api/v1/project?project=${id}`)).json();
    assert.equal(project.name, "web");
    assert.deepEqual(project.repos, []);
  });

  test("writes are authorized: a member cannot create a project", async () => {
    const r = await post("/api/v1/projects", { name: "nope" }, "guided");
    assert.equal(r.status, 403);
  });

  test("unknown routes and bad JSON are client errors", async () => {
    assert.equal((await post("/api/v1/nope", {})).status, 404);
    assert.equal((await fetch(BASE + "/api/v1/nope")).status, 404);
    const bad = await fetch(BASE + "/api/v1/projects", { method: "POST", body: "{" });
    assert.equal(bad.status, 400);
  });
});
