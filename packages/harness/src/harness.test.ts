import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { friendlySummary, type HarnessEvent } from "./adapter.ts";
import {
  ClaudeCodeAdapter,
  claudeArgv,
  claudeEnv,
  renderClaudeMd,
  type ProcessHandle,
  type Spawn,
} from "./claude-code.ts";

const CFG = {
  gatewayBaseUrl: "https://gw.example.com",
  projectKey: "sk-proj-abc",
  models: [{ id: "claude-sonnet-5-5", label: "Sonnet 5.5", api: "anthropic-messages" as const }],
  defaultModel: "claude-sonnet-5-5",
  instructions: "This project runs Odoo 18 in Docker.",
  workdir: "/work/s1/addons",
};

/** A fake Claude Code process we can feed stream-json lines into. */
function fakeProcess(lines: string[]): { handle: ProcessHandle; written: string[] } {
  const written: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const handle: ProcessHandle = {
    write: (l) => {
      written.push(l);
      release();
    },
    wait: async () => 0,
    kill: () => {},
    stdout: {
      async *[Symbol.asyncIterator]() {
        await gate; // emit only after the first prompt, like the real CLI
        for (const l of lines) yield l;
      },
    },
    stderr: { async *[Symbol.asyncIterator]() {} },
  };
  return { handle, written };
}

function adapterOver(lines: string[]): { adapter: ClaudeCodeAdapter; files: Record<string, string>; argv: string[][]; written: string[] } {
  const files: Record<string, string> = {};
  const argv: string[][] = [];
  let written: string[] = [];
  const spawn: Spawn = (a) => {
    argv.push(a);
    const { handle, written: w } = fakeProcess(lines);
    written = w;
    return handle;
  };
  const adapter = new ClaudeCodeAdapter({
    spawn,
    fs: {
      async mkdirp() {},
      async writeFile(p, c) {
        files[p] = c;
      },
    },
    home: "/root",
  });
  return { adapter, files, argv, get written() { return written; } } as never;
}

async function collect(adapter: ClaudeCodeAdapter, sessionId: string): Promise<HarnessEvent[]> {
  const out: HarnessEvent[] = [];
  for await (const e of adapter.events(sessionId)) out.push(e);
  return out;
}

describe("pointing Claude Code at the gateway", () => {
  test("env sends traffic to the gateway with the project key, never a provider key", () => {
    const env = claudeEnv(CFG, "claude-sonnet-5-5");
    assert.equal(env.ANTHROPIC_BASE_URL, "https://gw.example.com");
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, "sk-proj-abc");
    assert.equal(env.ANTHROPIC_MODEL, "claude-sonnet-5-5");
    assert.ok(!("ANTHROPIC_API_KEY" in env), "a provider key must never be set in the sandbox");
    assert.equal(env.CLAUDE_CODE_NONINTERACTIVE, "1");
  });

  test("argv uses bidirectional stream-json so events can be parsed as they arrive", () => {
    const a = claudeArgv({ model: "m", cwd: "/work" });
    assert.deepEqual(a.slice(0, 2), ["claude", "-p"]);
    assert.ok(a.includes("--output-format") && a[a.indexOf("--output-format") + 1] === "stream-json");
    assert.ok(a.includes("--input-format") && a[a.indexOf("--input-format") + 1] === "stream-json");
    assert.ok(a.includes("--model") && a[a.indexOf("--model") + 1] === "m");
  });

  test("configure writes CLAUDE.md with the blueprint's stack instructions", async () => {
    const { adapter, files } = adapterOver([]);
    await adapter.configure(CFG);
    const md = files["/work/s1/addons/CLAUDE.md"];
    assert.match(md, /Odoo 18 in Docker/);
    assert.match(md, /claude-sonnet-5-5/);
    assert.match(md, /Do not add provider API keys/);
    assert.ok(files["/root/.claude/settings.json"]);
  });

  test("CLAUDE.md is still coherent when a blueprint supplies no instructions", () => {
    const md = renderClaudeMd({ ...CFG, instructions: "   " });
    assert.match(md, /No stack-specific instructions/);
  });
});

describe("translating stream-json into normalized events", () => {
  test("assistant text and tool use become text.delta and tool.start", async () => {
    const { adapter } = adapterOver([
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "text", text: "Looking at the addon." },
            { type: "tool_use", id: "t1", name: "Read", input: { file_path: "/work/addons/models/sale.py" } },
          ],
        },
      }),
    ]);
    await adapter.configure(CFG);
    const id = await adapter.createSession({ cwd: "/work", model: "m" });
    await adapter.prompt(id, { text: "look at the sale model" });

    const events = await collect(adapter, id);
    assert.deepEqual(
      events.map((e) => e.type),
      ["message.start", "text.delta", "tool.start", "settled"],
    );
    const tool = events[2] as Extract<HarnessEvent, { type: "tool.start" }>;
    assert.equal(tool.name, "Read");
    assert.equal(tool.summary, "Read sale.py", "summary is user-safe, not a full path");
  });

  test("tool results become tool.end plus a truncated tool.output", async () => {
    const big = "x".repeat(5000);
    const { adapter } = adapterOver([
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", content: big }] },
      }),
    ]);
    await adapter.configure(CFG);
    const id = await adapter.createSession({ cwd: "/work", model: "m" });
    await adapter.prompt(id, { text: "go" });

    const events = await collect(adapter, id);
    const end = events.find((e) => e.type === "tool.end") as Extract<HarnessEvent, { type: "tool.end" }>;
    const out = events.find((e) => e.type === "tool.output") as Extract<HarnessEvent, { type: "tool.output" }>;
    assert.equal(end.ok, true);
    assert.equal(out.truncated, true);
    assert.equal(out.preview.length, 2000, "the log never swallows a 5 MB tool result");
  });

  test("a failed tool result is reported as not ok", async () => {
    const { adapter } = adapterOver([
      JSON.stringify({
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "t1", is_error: true, content: "boom" }] },
      }),
    ]);
    await adapter.configure(CFG);
    const id = await adapter.createSession({ cwd: "/work", model: "m" });
    await adapter.prompt(id, { text: "go" });
    const events = await collect(adapter, id);
    const end = events.find((e) => e.type === "tool.end") as Extract<HarnessEvent, { type: "tool.end" }>;
    assert.equal(end.ok, false);
  });

  test("a permission prompt is an approval.request, distinct from a question", async () => {
    const { adapter } = adapterOver([
      JSON.stringify({
        type: "control_request",
        request_id: "r1",
        request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "docker compose restart odoo" } },
      }),
    ]);
    await adapter.configure(CFG);
    const id = await adapter.createSession({ cwd: "/work", model: "m" });
    await adapter.prompt(id, { text: "restart" });

    const events = await collect(adapter, id);
    const req = events.find((e) => e.type === "approval.request") as Extract<HarnessEvent, { type: "approval.request" }>;
    assert.equal(req.action, "Bash");
    assert.equal(req.detail, "Restarted the services");
  });

  test("the result turn yields usage and, on failure, a retryable error", async () => {
    const { adapter } = adapterOver([
      JSON.stringify({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        result: "connection reset",
        usage: { input_tokens: 1200, output_tokens: 340 },
        total_cost_usd: 0.0123,
      }),
    ]);
    await adapter.configure(CFG);
    const id = await adapter.createSession({ cwd: "/work", model: "m" });
    await adapter.prompt(id, { text: "go" });

    const events = await collect(adapter, id);
    const usage = events.find((e) => e.type === "usage") as Extract<HarnessEvent, { type: "usage" }>;
    assert.equal(usage.inputTokens, 1200);
    assert.equal(usage.costUsd, 0.0123);
    const err = events.find((e) => e.type === "error") as Extract<HarnessEvent, { type: "error" }>;
    assert.equal(err.retryable, true);
  });

  test("hitting the turn limit is not retryable", async () => {
    const { adapter } = adapterOver([
      JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "max turns" }),
    ]);
    await adapter.configure(CFG);
    const id = await adapter.createSession({ cwd: "/work", model: "m" });
    await adapter.prompt(id, { text: "go" });
    const err = (await collect(adapter, id)).find((e) => e.type === "error") as Extract<HarnessEvent, { type: "error" }>;
    assert.equal(err.retryable, false);
  });

  test("non-JSON noise on stdout does not kill the stream", async () => {
    const { adapter } = adapterOver([
      "npm notice a new version is available",
      "",
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } }),
    ]);
    await adapter.configure(CFG);
    const id = await adapter.createSession({ cwd: "/work", model: "m" });
    await adapter.prompt(id, { text: "go" });
    const events = await collect(adapter, id);
    assert.ok(events.some((e) => e.type === "text.delta"));
  });

  test("every event carries sessionId, a gapless seq and a timestamp", async () => {
    const { adapter } = adapterOver([
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] } }),
    ]);
    await adapter.configure(CFG);
    const id = await adapter.createSession({ cwd: "/work", model: "m" });
    await adapter.prompt(id, { text: "go" });

    const events = await collect(adapter, id);
    assert.deepEqual(events.map((e) => e.seq), [0, 1, 2, 3]);
    assert.ok(events.every((e) => e.sessionId === id));
    assert.ok(events.every((e) => !Number.isNaN(Date.parse(e.at))));
  });

  test("the stream always ends with settled", async () => {
    const { adapter } = adapterOver([JSON.stringify({ type: "system", subtype: "init" })]);
    await adapter.configure(CFG);
    const id = await adapter.createSession({ cwd: "/work", model: "m" });
    await adapter.prompt(id, { text: "go" });
    const events = await collect(adapter, id);
    assert.equal(events.at(-1)!.type, "settled");
  });
});

describe("tool summaries stay readable for a non-technical viewer", () => {
  const cases: Array<[string, unknown, string]> = [
    ["Read", { file_path: "/work/addons/models/sale_order.py" }, "Read sale_order.py"],
    ["Edit", { file_path: "/a/b/theme.css" }, "Edited theme.css"],
    ["Bash", { command: "npm test -- --run" }, "Ran the tests"],
    ["Bash", { command: "pytest -q tests/" }, "Ran the tests"],
    ["Bash", { command: "npm install" }, "Installed dependencies"],
    ["Bash", { command: "docker compose restart odoo" }, "Restarted the services"],
    ["Bash", { command: "git commit -m 'x'" }, "Saved its work"],
    ["Bash", { command: "awk '{print $1}' f" }, "Ran a command"],
    ["Grep", { pattern: "TODO" }, "Searched the code"],
    ["TodoWrite", {}, "Updated its plan"],
  ];

  for (const [tool, input, expected] of cases) {
    test(`${tool}: ${expected}`, () => {
      assert.equal(friendlySummary(tool, input), expected);
    });
  }

  test("no summary leaks an absolute path, a flag or a container name", () => {
    for (const [tool, input] of cases) {
      const s = friendlySummary(tool, input);
      assert.ok(!s.includes("/"), `path leaked: ${s}`);
      assert.ok(!s.includes("--"), `flag leaked: ${s}`);
    }
  });
});
