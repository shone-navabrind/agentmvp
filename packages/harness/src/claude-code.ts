import { KernelError } from "@harness/kernel";
import {
  friendlySummary,
  HarnessNotInstalled,
  type Attachment,
  type HarnessAdapter,
  type HarnessConfig,
  type HarnessEvent,
} from "./adapter.ts";

/**
 * Claude Code adapter.
 *
 * Driven as `claude -p --output-format stream-json --input-format stream-json`, which
 * emits newline-delimited JSON. The gateway is reached through ANTHROPIC_BASE_URL and
 * the project's virtual key, so no provider credential ever lands in the sandbox.
 */

export type ProcessHandle = {
  write(line: string): void;
  /** Resolves when the process exits. */
  wait(): Promise<number>;
  kill(): void;
  stdout: AsyncIterable<string>;
  stderr: AsyncIterable<string>;
};

export type Spawn = (
  argv: string[],
  opts: { cwd: string; env: Record<string, string> },
) => ProcessHandle;

export type FileOps = {
  mkdirp(path: string): Promise<void>;
  writeFile(path: string, content: string): Promise<void>;
};

/** Environment Claude Code needs to talk to the gateway instead of api.anthropic.com. */
export function claudeEnv(cfg: HarnessConfig, model: string): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: cfg.gatewayBaseUrl,
    ANTHROPIC_AUTH_TOKEN: cfg.projectKey,
    ANTHROPIC_MODEL: model,
    // Claude Code otherwise probes for an OAuth token and prompts interactively.
    CLAUDE_CODE_NONINTERACTIVE: "1",
    DISABLE_AUTOUPDATER: "1",
  };
}

export function claudeArgv(opts: { model: string; cwd: string }): string[] {
  return [
    "claude",
    "-p",
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
    "--model",
    opts.model,
    "--add-dir",
    opts.cwd,
  ];
}

/** CLAUDE.md carries the blueprint's instructions so the agent knows its stack. */
export function renderClaudeMd(cfg: HarnessConfig): string {
  return [
    "# Project context",
    "",
    cfg.instructions.trim() || "_No stack-specific instructions were provided._",
    "",
    "## Models available here",
    ...cfg.models.map((m) => `- \`${m.id}\` — ${m.label}`),
    "",
    "All model traffic goes through the platform gateway. Do not add provider API keys.",
  ].join("\n");
}

type Session = {
  id: string;
  proc: ProcessHandle;
  seq: number;
  queue: HarnessEvent[];
  waiters: Array<(e: HarnessEvent | null) => void>;
  closed: boolean;
};

export class ClaudeCodeAdapter implements HarnessAdapter {
  readonly id = "claude-code" as const;
  #spawn: Spawn;
  #fs: FileOps;
  #cfg: HarnessConfig | null = null;
  #sessions = new Map<string, Session>();
  #home: string;

  constructor(opts: { spawn: Spawn; fs: FileOps; home?: string }) {
    this.#spawn = opts.spawn;
    this.#fs = opts.fs;
    this.#home = opts.home ?? "/root";
  }

  async check(): Promise<{ installed: boolean; version: string }> {
    const proc = this.#spawn(["claude", "--version"], { cwd: "/", env: {} });
    let out = "";
    for await (const line of proc.stdout) out += line;
    const code = await proc.wait();
    if (code !== 0) throw new HarnessNotInstalled(this.id, out.trim() || `exit ${code}`);
    return { installed: true, version: out.trim() };
  }

  async configure(cfg: HarnessConfig): Promise<void> {
    this.#cfg = cfg;
    await this.#fs.mkdirp(`${this.#home}/.claude`);
    await this.#fs.writeFile(`${cfg.workdir}/CLAUDE.md`, renderClaudeMd(cfg));
    // Settings, not env, is where a non-interactive run gets its permission posture.
    await this.#fs.writeFile(
      `${this.#home}/.claude/settings.json`,
      JSON.stringify({ env: claudeEnv(cfg, cfg.defaultModel), includeCoAuthoredBy: false }, null, 2),
    );
  }

  async createSession(opts: { cwd: string; model: string }): Promise<string> {
    if (!this.#cfg) throw new KernelError("HARNESS_NOT_CONFIGURED", "configure() first", {}, false);
    const id = `cc-${Math.random().toString(36).slice(2, 10)}`;
    const proc = this.#spawn(claudeArgv({ model: opts.model, cwd: opts.cwd }), {
      cwd: opts.cwd,
      env: claudeEnv(this.#cfg, opts.model),
    });

    const session: Session = { id, proc, seq: 0, queue: [], waiters: [], closed: false };
    this.#sessions.set(id, session);
    void this.#pump(session);
    return id;
  }

  #emit(s: Session, partial: Omit<HarnessEvent, "sessionId" | "seq" | "at">): void {
    const event = {
      ...partial,
      sessionId: s.id,
      seq: s.seq++,
      at: new Date().toISOString(),
    } as HarnessEvent;
    const waiter = s.waiters.shift();
    if (waiter) waiter(event);
    else s.queue.push(event);
  }

  /** Translate Claude Code's stream-json into the normalized event shape. */
  async #pump(s: Session): Promise<void> {
    try {
      for await (const line of s.proc.stdout) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(trimmed);
        } catch {
          continue; // non-JSON noise on stdout is not fatal
        }
        this.#translate(s, msg);
      }
    } finally {
      this.#emit(s, { type: "settled" } as never);
      s.closed = true;
      for (const w of s.waiters.splice(0)) w(null);
    }
  }

  #translate(s: Session, msg: Record<string, unknown>): void {
    const type = msg.type as string;

    if (type === "assistant") {
      const message = (msg.message ?? {}) as { content?: unknown[] };
      this.#emit(s, { type: "message.start", role: "assistant" } as never);
      for (const block of message.content ?? []) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          this.#emit(s, { type: "text.delta", text: b.text } as never);
        } else if (b.type === "tool_use") {
          this.#emit(s, {
            type: "tool.start",
            id: String(b.id),
            name: String(b.name),
            summary: friendlySummary(String(b.name), b.input),
          } as never);
        }
      }
      return;
    }

    if (type === "user") {
      // Tool results come back as a synthetic user turn.
      const message = (msg.message ?? {}) as { content?: unknown[] };
      for (const block of message.content ?? []) {
        const b = block as Record<string, unknown>;
        if (b.type !== "tool_result") continue;
        const ok = b.is_error !== true;
        const text = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        this.#emit(s, {
          type: "tool.end",
          id: String(b.tool_use_id),
          ok,
          summary: ok ? "Done" : "Failed",
        } as never);
        this.#emit(s, {
          type: "tool.output",
          id: String(b.tool_use_id),
          preview: text.slice(0, 2000),
          truncated: text.length > 2000,
        } as never);
      }
      return;
    }

    if (type === "stream_event") {
      const ev = (msg.event ?? {}) as { type?: string; delta?: { type?: string; text?: string } };
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        this.#emit(s, { type: "text.delta", text: ev.delta.text } as never);
      }
      return;
    }

    if (type === "control_request") {
      // Permission prompts arrive here in stream-json mode; they are approvals, not questions.
      const req = (msg.request ?? {}) as { subtype?: string; tool_name?: string; input?: unknown };
      if (req.subtype === "can_use_tool") {
        this.#emit(s, {
          type: "approval.request",
          id: String(msg.request_id ?? ""),
          action: String(req.tool_name ?? "unknown"),
          detail: friendlySummary(String(req.tool_name ?? ""), req.input),
        } as never);
      }
      return;
    }

    if (type === "result") {
      const usage = (msg.usage ?? {}) as { input_tokens?: number; output_tokens?: number };
      this.#emit(s, {
        type: "usage",
        inputTokens: usage.input_tokens ?? 0,
        outputTokens: usage.output_tokens ?? 0,
        costUsd: typeof msg.total_cost_usd === "number" ? msg.total_cost_usd : undefined,
      } as never);
      if (msg.is_error === true || msg.subtype === "error_during_execution") {
        this.#emit(s, {
          type: "error",
          message: String(msg.result ?? "the assistant stopped unexpectedly"),
          // A turn that failed mid-execution is worth one retry; a refusal is not.
          retryable: msg.subtype !== "error_max_turns",
        } as never);
      }
      return;
    }

    if (type === "system" && msg.subtype === "init") {
      // Session bootstrap; nothing user-visible.
      return;
    }
  }

  async prompt(sessionId: string, input: { text: string; attachments?: Attachment[] }): Promise<void> {
    const s = this.#must(sessionId);
    const content: unknown[] = [{ type: "text", text: input.text }];
    for (const a of input.attachments ?? []) {
      content.push({ type: "text", text: `[attached: ${a.name} (${a.mimeType}) at ${a.ref}]` });
    }
    s.proc.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  }

  async abort(sessionId: string): Promise<void> {
    const s = this.#must(sessionId);
    s.proc.write(JSON.stringify({ type: "control_request", request: { subtype: "interrupt" } }) + "\n");
  }

  events(sessionId: string): AsyncIterable<HarnessEvent> {
    const s = this.#must(sessionId);
    return {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<HarnessEvent>> {
            const queued = s.queue.shift();
            if (queued) return { value: queued, done: false };
            if (s.closed) return { value: undefined as never, done: true };
            const event = await new Promise<HarnessEvent | null>((resolve) => s.waiters.push(resolve));
            return event ? { value: event, done: false } : { value: undefined as never, done: true };
          },
        };
      },
    };
  }

  async close(sessionId: string): Promise<void> {
    const s = this.#sessions.get(sessionId);
    if (!s) return;
    s.proc.kill();
    this.#sessions.delete(sessionId);
  }

  #must(id: string): Session {
    const s = this.#sessions.get(id);
    if (!s) throw new KernelError("NO_SUCH_SESSION", `No harness session "${id}"`, { id }, false);
    return s;
  }
}
