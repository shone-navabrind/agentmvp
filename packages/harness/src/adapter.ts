import { KernelError } from "@harness/kernel";

/** Normalized across every harness. The UI and the event log only ever see this shape. */
export type HarnessEvent =
  | { type: "message.start"; sessionId: string; seq: number; at: string; role: "assistant" }
  | { type: "text.delta"; sessionId: string; seq: number; at: string; text: string }
  | { type: "tool.start"; sessionId: string; seq: number; at: string; id: string; name: string; summary: string }
  | { type: "tool.end"; sessionId: string; seq: number; at: string; id: string; ok: boolean; summary: string }
  | { type: "tool.output"; sessionId: string; seq: number; at: string; id: string; preview: string; truncated: boolean; ref?: string }
  | { type: "question"; sessionId: string; seq: number; at: string; id: string; text: string; options?: string[] }
  | { type: "approval.request"; sessionId: string; seq: number; at: string; id: string; action: string; detail: string }
  | { type: "usage"; sessionId: string; seq: number; at: string; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: "error"; sessionId: string; seq: number; at: string; message: string; retryable: boolean }
  | { type: "settled"; sessionId: string; seq: number; at: string };

export type CatalogModel = {
  id: string;
  label: string;
  api: "anthropic-messages" | "openai-responses" | "openai-completions" | "google-generative-ai";
};

export type HarnessConfig = {
  gatewayBaseUrl: string;
  /** The only credential that ever enters the sandbox: scoped, capped, revocable. */
  projectKey: string;
  models: CatalogModel[];
  defaultModel: string;
  instructions: string;
  workdir: string;
};

export type Attachment = { name: string; mimeType: string; ref: string };

export interface HarnessAdapter {
  readonly id: "pi" | "claude-code" | "codex" | "opencode";
  check(): Promise<{ installed: boolean; version: string }>;
  configure(cfg: HarnessConfig): Promise<void>;
  createSession(opts: { cwd: string; model: string }): Promise<string>;
  prompt(sessionId: string, input: { text: string; attachments?: Attachment[] }): Promise<void>;
  abort(sessionId: string): Promise<void>;
  events(sessionId: string): AsyncIterable<HarnessEvent>;
  close(sessionId: string): Promise<void>;
}

export class HarnessNotInstalled extends KernelError {
  constructor(id: string, detail: string) {
    super("HARNESS_NOT_INSTALLED", `Harness "${id}" is not available: ${detail}`, { id, detail }, false);
  }
}

/** Tool activity shown to a non-technical user must never leak paths or raw arguments. */
export function friendlySummary(toolName: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const base = (p: unknown) => String(p ?? "").split("/").filter(Boolean).pop() ?? "a file";
  switch (toolName) {
    case "Read":
      return `Read ${base(i.file_path)}`;
    case "Write":
      return `Wrote ${base(i.file_path)}`;
    case "Edit":
      return `Edited ${base(i.file_path)}`;
    case "Bash":
      return describeCommand(String(i.command ?? ""));
    case "Glob":
    case "Grep":
      return "Searched the code";
    case "WebFetch":
    case "WebSearch":
      return "Looked something up";
    case "TodoWrite":
      return "Updated its plan";
    default:
      return `Used ${toolName}`;
  }
}

/** A short, non-technical gloss for a shell command. */
function describeCommand(cmd: string): string {
  const c = cmd.trim().toLowerCase();
  if (/\b(npm|pnpm|yarn|bun)\s+(test|run test)/.test(c) || /\bpytest|go test|cargo test\b/.test(c)) return "Ran the tests";
  if (/\b(npm|pnpm|yarn|bun)\s+(install|ci|add)\b/.test(c) || /\bpip install\b/.test(c)) return "Installed dependencies";
  if (/\b(npm|pnpm|yarn|bun)\s+run\s+(build|compile)\b/.test(c) || /\btsc\b/.test(c)) return "Built the project";
  if (/^git\s+commit/.test(c)) return "Saved its work";
  if (/^git\s+(status|diff|log)/.test(c)) return "Checked what changed";
  if (/^docker\s+compose\s+(up|restart|start)/.test(c)) return "Restarted the services";
  if (/^docker\s+compose\s+logs/.test(c)) return "Checked the logs";
  if (/^(ls|cat|head|tail|find)\b/.test(c)) return "Looked at the files";
  return "Ran a command";
}
