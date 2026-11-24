import { z } from "zod";
import { SuspendRun } from "@harness/kernel";
import { defineNode, EgressDenied, type NodeType } from "./types.ts";
import { NodeRegistry } from "./registry.ts";

/** Seed state with a literal. The cheapest way to start a graph. */
export const constNode = defineNode({
  type: "core.const",
  configSchema: z.object({ value: z.unknown() }),
  inputSchema: z.object({}),
  outputSchema: z.object({ value: z.unknown() }),
  async execute(_ctx, config) {
    return { value: config.value };
  },
});

/** A branch point: edges off this node carry the conditions. */
export const checkNode = defineNode({
  type: "core.check",
  configSchema: z.object({}),
  inputSchema: z.object({ value: z.unknown() }),
  outputSchema: z.object({ value: z.unknown(), truthy: z.boolean() }),
  async execute(_ctx, _cfg, input) {
    return { value: input.value, truthy: Boolean(input.value) };
  },
});

export const incrementNode = defineNode({
  type: "core.increment",
  configSchema: z.object({ by: z.number().default(1) }),
  inputSchema: z.object({ from: z.number() }),
  outputSchema: z.object({ n: z.number() }),
  async execute(_ctx, config, input) {
    return { n: input.from + config.by };
  },
});

/**
 * Human-in-the-loop. Suspends the run; the question surfaces in the approval inbox.
 * resume() writes the answer as this step's result, so on re-execution the memoised value
 * comes back and the flow carries on from exactly here -- no re-running earlier nodes.
 */
export const approvalNode = defineNode({
  type: "core.approval",
  configSchema: z.object({ options: z.array(z.string()).default(["approve", "reject"]) }),
  inputSchema: z.object({ question: z.string(), context: z.unknown().optional() }),
  outputSchema: z.object({ decision: z.string(), by: z.string().optional() }),
  suspends: true,
  async execute(ctx, config, input) {
    return ctx.step(`approval:${ctx.nodeId}`, async () => {
      throw new SuspendRun(`approval:${ctx.nodeId}`, {
        text: input.question,
        options: config.options,
        meta: { nodeId: ctx.nodeId, context: input.context },
      });
    });
  },
});

/** Fan-out with a concurrency limit. Each item is its own memoised sub-step. */
export function mapNode<T extends z.ZodType, R extends z.ZodType>(
  type: string,
  itemSchema: T,
  resultSchema: R,
  fn: (item: T["_output"], index: number) => Promise<R["_output"]>,
): NodeType<{ concurrency: number }, { items: T["_output"][] }, { results: R["_output"][] }> {
  return defineNode({
    type,
    configSchema: z.object({ concurrency: z.number().int().positive().default(4) }),
    inputSchema: z.object({ items: z.array(itemSchema) }),
    outputSchema: z.object({ results: z.array(resultSchema) }),
    async execute(ctx, config, input) {
      const results: R["_output"][] = new Array(input.items.length);
      let cursor = 0;
      const workers = Array.from(
        { length: Math.min(config.concurrency, input.items.length) },
        async () => {
          for (;;) {
            const i = cursor++;
            if (i >= input.items.length) return;
            results[i] = await ctx.step(`${ctx.nodeId}#${ctx.iteration}:item:${i}`, () =>
              fn(input.items[i], i),
            );
          }
        },
      );
      await Promise.all(workers);
      return { results };
    },
  });
}

/** An agent turn. The real implementation drives a harness session; this is the contract. */
export function agentNode(
  run: (prompt: string, model: string) => Promise<{ text: string; costUsd: number }>,
) {
  return defineNode({
    type: "agent.turn",
    configSchema: z.object({ model: z.string(), costCapUsd: z.number().optional() }),
    inputSchema: z.object({ prompt: z.string() }),
    outputSchema: z.object({ text: z.string(), costUsd: z.number() }),
    async execute(ctx, config, input) {
      const res = await run(input.prompt, config.model);
      ctx.budget.charge(res.costUsd);
      if (config.costCapUsd !== undefined) ctx.budget.assertUnder(config.costCapUsd);
      return res;
    },
  });
}

/**
 * HTTP egress, default-deny.
 *
 * Reach is the intersection of the workspace policy and the node's own list. An
 * earlier version treated an empty node list as "allow everything" and had no
 * workspace layer at all, which meant the attacker in the threat model wrote their own
 * policy. Redirects are not followed: a permitted host that 302s to the cloud metadata
 * address would otherwise bypass the check entirely.
 */
export function httpNode(fetchImpl: typeof fetch = fetch) {
  return defineNode({
    type: "http.request",
    configSchema: z.object({
      method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
      allowHosts: z.array(z.string()).default([]),
      /** Up to this many redirects, each re-checked against the policy. */
      maxRedirects: z.number().int().min(0).max(5).default(0),
    }),
    inputSchema: z.object({ url: z.string().url(), body: z.unknown().optional() }),
    outputSchema: z.object({ status: z.number(), body: z.unknown() }),
    idempotent: false,
    async execute(ctx, config, input) {
      const workspace = ctx.egress?.allowHosts ?? [];
      const permitted = config.allowHosts.length
        ? workspace.filter((h) => config.allowHosts.includes(h))
        : workspace;

      const check = (url: string): string => {
        const u = new URL(url);
        if (u.protocol !== "https:" && u.hostname !== "localhost") {
          throw new EgressDenied(u.hostname, "only https is permitted");
        }
        if (permitted.length === 0) {
          throw new EgressDenied(u.hostname, "this workspace permits no outbound requests from flows");
        }
        if (!permitted.includes(u.hostname)) {
          throw new EgressDenied(u.hostname, "not in the workspace egress allowlist");
        }
        return url;
      };

      let url = check(input.url);
      let res: Response;
      for (let hop = 0; ; hop++) {
        res = await fetchImpl(url, {
          method: config.method,
          redirect: "manual",
          body: input.body === undefined ? undefined : JSON.stringify(input.body),
          headers: input.body === undefined ? undefined : { "content-type": "application/json" },
        });
        const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
        if (!location) break;
        if (hop >= config.maxRedirects) {
          throw new EgressDenied(new URL(url).hostname, `redirected, and maxRedirects is ${config.maxRedirects}`);
        }
        // Re-check every hop against the same policy.
        url = check(new URL(location, url).toString());
      }

      const text = await res.text();
      let body: unknown = text;
      try {
        body = JSON.parse(text);
      } catch {
        /* plain-text response */
      }
      return { status: res.status, body };
    },
  });
}

export function standardNodes(): NodeRegistry {
  return new NodeRegistry()
    .register(constNode)
    .register(checkNode)
    .register(incrementNode)
    .register(approvalNode);
}
