import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  apiCompatible,
  capabilityCovers,
  CapabilityNotGranted,
  IncompatibleApiVersion,
  ManifestInvalid,
  parseManifest,
  UntrustedInProcess,
} from "./manifest.ts";
import { CircuitOpen, PluginCallFailed, PluginHost, type PluginModule } from "./host.ts";

const base = {
  id: "acme.jira",
  version: "1.0.0",
  apiVersion: "^1.0",
  runtime: "in-process" as const,
  trust: "verified" as const,
  provides: [{ point: "connector.egress" as const, name: "jira" }],
  capabilities: ["http:egress:api.atlassian.com", "secret:read:workspace/jira-token"],
};

function host(over: Partial<ConstructorParameters<typeof PluginHost>[0]> = {}) {
  const emitted: Array<{ pluginId: string; type: string }> = [];
  const h = new PluginHost({
    apiVersion: "1.2.0",
    async emit(pluginId, type) {
      emitted.push({ pluginId, type });
    },
    async secret() {
      return "s3cret";
    },
    failureThreshold: 3,
    callTimeoutMs: 100,
    ...over,
  });
  return { h, emitted };
}

function mod(manifest: unknown, exports: Record<string, unknown>): PluginModule {
  return { manifest: parseManifest(manifest), activate: () => exports };
}

describe("manifest", () => {
  test("accepts a well-formed manifest", () => {
    assert.equal(parseManifest(base).id, "acme.jira");
  });

  test("rejects a bad id, bad version and an empty provides list", () => {
    assert.throws(() => parseManifest({ ...base, id: "Jira" }), ManifestInvalid);
    assert.throws(() => parseManifest({ ...base, version: "v1" }), ManifestInvalid);
    assert.throws(() => parseManifest({ ...base, provides: [] }), ManifestInvalid);
  });

  test("rejects a malformed capability string", () => {
    assert.throws(() => parseManifest({ ...base, capabilities: ["DoAnything"] }), ManifestInvalid);
  });

  test("rejects an unknown extension point", () => {
    assert.throws(
      () => parseManifest({ ...base, provides: [{ point: "wat", name: "x" }] }),
      ManifestInvalid,
    );
  });

  test("api compatibility is a range check, not string equality", () => {
    assert.equal(apiCompatible("^1.0", "1.2.0"), true);
    assert.equal(apiCompatible("^1.3", "1.2.0"), false, "needs newer minor than the host");
    assert.equal(apiCompatible("^2.0", "1.2.0"), false, "major mismatch");
    assert.equal(apiCompatible("1.2", "1.2.5"), true);
  });

  test("a declared capability may be a prefix wildcard", () => {
    assert.equal(capabilityCovers("http:egress:api.atlassian.com", "http:egress:api.atlassian.com"), true);
    assert.equal(capabilityCovers("http:egress:*", "http:egress:evil.example"), true);
    assert.equal(capabilityCovers("http:egress:api.atlassian.com", "http:egress:evil.example"), false);
    assert.equal(capabilityCovers("events:read:*", "events:write:task.moved"), false);
  });
});

describe("loading", () => {
  test("loads a compatible plugin and exposes it at its extension point", async () => {
    const { h } = host();
    await h.load(mod(base, { jira: { send: async () => "ok" } }));
    const impls = h.implementations("connector.egress");
    assert.equal(impls.length, 1);
    assert.equal(impls[0].pluginId, "acme.jira");
  });

  test("refuses an incompatible host API at load, not at first call", async () => {
    const { h } = host();
    await assert.rejects(
      () => h.load(mod({ ...base, apiVersion: "^9.0" }, { jira: {} })),
      IncompatibleApiVersion,
    );
  });

  test("REFUSES to run an untrusted plugin in the API process", async () => {
    const { h } = host();
    await assert.rejects(
      () => h.load(mod({ ...base, trust: "untrusted", runtime: "in-process" }, { jira: {} })),
      UntrustedInProcess,
    );
  });

  test("an untrusted plugin is allowed out-of-process", async () => {
    const { h } = host();
    const loaded = await h.load(
      mod({ ...base, trust: "untrusted", runtime: "container" }, { jira: {} }),
    );
    assert.equal(loaded.state, "active");
  });

  test("a plugin cannot export something its manifest does not declare", async () => {
    const { h } = host();
    await assert.rejects(
      () => h.load(mod(base, { jira: {}, secretBackdoor: {} })),
      /does not declare/,
    );
  });
});

describe("capability enforcement", () => {
  test("a plugin may reach only the hosts it declared", async () => {
    const calls: string[] = [];
    const { h } = host({
      fetch: (async (url: string) => {
        calls.push(String(url));
        return new Response("ok");
      }) as unknown as typeof fetch,
    });

    let api: Parameters<PluginModule["activate"]>[0] | undefined;
    await h.load({
      manifest: parseManifest(base),
      activate(a) {
        api = a;
        return { jira: {} };
      },
    });

    await api!.fetch("https://api.atlassian.com/issue");
    assert.deepEqual(calls, ["https://api.atlassian.com/issue"]);

    await assert.rejects(() => api!.fetch("https://evil.example/exfil"), CapabilityNotGranted);
    assert.equal(calls.length, 1, "the undeclared request never left the process");
  });

  test("a plugin may read only the secrets it declared", async () => {
    const { h } = host();
    let api: Parameters<PluginModule["activate"]>[0] | undefined;
    await h.load({
      manifest: parseManifest(base),
      activate(a) {
        api = a;
        return { jira: {} };
      },
    });

    assert.equal(await api!.secret("secret://workspace/jira-token"), "s3cret");
    await assert.rejects(
      () => api!.secret("secret://workspace/anthropic-key"),
      CapabilityNotGranted,
    );
  });

  test("a plugin may emit only event types it declared", async () => {
    const { h, emitted } = host();
    let api: Parameters<PluginModule["activate"]>[0] | undefined;
    await h.load({
      manifest: parseManifest({ ...base, capabilities: ["events:write:jira.*"] }),
      activate(a) {
        api = a;
        return { jira: {} };
      },
    });

    await api!.emit("jira.issue.created", { key: "ENG-1" });
    assert.equal(emitted.length, 1);
    await assert.rejects(() => api!.emit("task.moved", {}), CapabilityNotGranted);
    assert.equal(emitted.length, 1);
  });
});

describe("supervision: one bad plugin must not take down the host", () => {
  test("a throwing plugin is circuit-broken after the threshold", async () => {
    const { h } = host();
    await h.load(
      mod(base, {
        jira: {
          send: async () => {
            throw new Error("upstream 500");
          },
        },
      }),
    );
    const call = () =>
      h.call("acme.jira", "jira", (impl) => (impl as { send: () => Promise<void> }).send());

    for (let i = 0; i < 3; i++) await assert.rejects(call, PluginCallFailed);
    assert.equal(h.get("acme.jira")!.state, "disabled");
    await assert.rejects(call, CircuitOpen);

    // A disabled plugin disappears from its extension point; the host keeps serving.
    assert.deepEqual(h.implementations("connector.egress"), []);
  });

  test("a hanging plugin is timed out rather than blocking the host forever", async () => {
    const { h } = host({ callTimeoutMs: 50 });
    await h.load(
      mod(base, { jira: { send: () => new Promise(() => {/* never settles */}) } }),
    );
    const started = Date.now();
    await assert.rejects(
      () => h.call("acme.jira", "jira", (impl) => (impl as { send: () => Promise<void> }).send()),
      /timed out after 50ms/,
    );
    assert.ok(Date.now() - started < 1000, "returned promptly instead of hanging");
  });

  test("a successful call resets the failure count", async () => {
    const { h } = host();
    let fail = true;
    await h.load(
      mod(base, {
        jira: {
          send: async () => {
            if (fail) throw new Error("transient");
            return "ok";
          },
        },
      }),
    );
    const call = () =>
      h.call("acme.jira", "jira", (impl) => (impl as { send: () => Promise<string> }).send());

    await assert.rejects(call, PluginCallFailed);
    await assert.rejects(call, PluginCallFailed);
    assert.equal(h.get("acme.jira")!.failures, 2);

    fail = false;
    assert.equal(await call(), "ok");
    assert.equal(h.get("acme.jira")!.failures, 0, "breaker reset; no latent trip");
  });

  test("an admin can re-enable a circuit-broken plugin", async () => {
    const { h } = host({ failureThreshold: 1 });
    await h.load(
      mod(base, {
        jira: {
          send: async () => {
            throw new Error("bad config");
          },
        },
      }),
    );
    await assert.rejects(() =>
      h.call("acme.jira", "jira", (i) => (i as { send: () => Promise<void> }).send()),
    );
    assert.equal(h.get("acme.jira")!.state, "disabled");
    assert.match(h.get("acme.jira")!.lastError!, /bad config/);

    h.reset("acme.jira");
    assert.equal(h.get("acme.jira")!.state, "active");
    assert.equal(h.implementations("connector.egress").length, 1);
  });
});
