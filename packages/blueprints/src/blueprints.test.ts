import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { CATALOG, findBlueprint, searchCatalog } from "./catalog.ts";
import { assertBlueprint, BlueprintInvalid, requirementsOf, validateBlueprint } from "./validate.ts";
import {
  BindingsIncomplete,
  checkBindings,
  compileProvisioning,
  friendlyStepLabels,
  interpolate,
  primaryPort,
  renderCompose,
  type Bindings,
} from "./compile.ts";
import {
  buildPrompt,
  needsReview,
  saveAsTemplate,
  synthesizeBlueprint,
  SynthesisFailed,
  type BlueprintModel,
} from "./synthesize.ts";
import { NodeRegistry } from "@harness/flow";

const odoo = findBlueprint("odoo-18-enterprise")!;

const odooBindings: Bindings = {
  inputs: { DB_PASSWORD: "s3cret", ODOO_DB_NAME: "acme" },
  seeds: { devdb: "artifact://dumps/acme.sql", filestore: null },
  repos: { addons: ["acme-addons"], enterprise: [] },
};

describe("catalog", () => {
  test("every shipped blueprint is valid", () => {
    // CATALOG is built with assertBlueprint, so reaching here already proves it,
    // but name the invariant so a future edit fails loudly.
    assert.ok(CATALOG.length >= 3);
    for (const bp of CATALOG) assert.deepEqual(validateBlueprint(bp).ok, true, bp.id);
  });

  test("search matches id, name, summary and tags", () => {
    assert.equal(searchCatalog("odoo")[0].id, "odoo-18-enterprise");
    assert.equal(searchCatalog("erp")[0].id, "odoo-18-enterprise");
    assert.equal(searchCatalog("wordpress").length, 1);
    assert.equal(searchCatalog("").length, CATALOG.length);
    assert.deepEqual(searchCatalog("cobol"), []);
  });

  test("every blueprint speaks plainly to a non-technical reader", () => {
    const jargon = /docker|container|compose|localhost|port \d|sql dump|daemon/i;
    for (const bp of CATALOG) {
      assert.ok(bp.ui.whatYouGet.length >= 2, `${bp.id} needs whatYouGet`);
      for (const line of bp.ui.whatYouGet) {
        assert.ok(!jargon.test(line), `${bp.id}: jargon in non-technical copy: "${line}"`);
      }
    }
  });

  test("production data is neutralised by default wherever a dump can be uploaded", () => {
    for (const bp of CATALOG) {
      for (const seed of bp.seeds.filter((s) => s.kind !== "files")) {
        assert.equal(seed.neutralize.enabled, true, `${bp.id}/${seed.id} must scrub by default`);
      }
    }
    const devdb = odoo.seeds.find((s) => s.id === "devdb")!;
    assert.ok(devdb.neutralize.recipes.includes("odoo-disable-mail"));
    assert.ok(devdb.neutralize.recipes.includes("odoo-disable-cron"));
  });
});

describe("validation catches what a model gets wrong", () => {
  const base = {
    id: "x", version: "1.0.0", name: "X", summary: "x",
    services: [
      { name: "db", image: "postgres:16", dataKind: "postgres", ports: [], healthcheck: { test: "pg_isready" } },
      { name: "web", image: "nginx:1", ports: [{ container: 80, primary: true }], dependsOn: ["db"] },
    ],
    verify: [{ id: "up", label: "up", kind: "http", target: "http://localhost/" }],
    ui: { whatYouGet: ["A working site", "A preview you can click"] },
  };

  test("accepts a well-formed blueprint", () => {
    assert.equal(validateBlueprint(base).ok, true);
  });

  test("rejects a seed pointed at a service that holds no data", () => {
    const r = validateBlueprint({
      ...base,
      seeds: [{ id: "d", label: "d", kind: "postgres", service: "web" }],
    }) as { ok: false; problems: string[] };
    assert.match(r.problems.join(" "), /declares dataKind "none"/);
  });

  test("rejects a seed whose kind does not match the service", () => {
    const r = validateBlueprint({
      ...base,
      seeds: [{ id: "d", label: "d", kind: "mysql", service: "db" }],
    }) as { ok: false; problems: string[] };
    assert.match(r.problems.join(" "), /is mysql but service "db" holds postgres/);
  });

  test("rejects an unresolvable ${input.X} reference", () => {
    const r = validateBlueprint({
      ...base,
      services: [{ ...base.services[0], env: { PW: "${input.NOPE}" } }, base.services[1]],
    }) as { ok: false; problems: string[] };
    assert.match(r.problems.join(" "), /\$\{input\.NOPE\} has no matching input/);
  });

  test("rejects a service dependency cycle", () => {
    const r = validateBlueprint({
      ...base,
      services: [
        { ...base.services[0], dependsOn: ["web"] },
        { ...base.services[1], dependsOn: ["db"] },
      ],
    }) as { ok: false; problems: string[] };
    assert.match(r.problems.join(" "), /dependency cycle/);
  });

  test("rejects two services binding the same host port", () => {
    const r = validateBlueprint({
      ...base,
      services: [
        { ...base.services[0], ports: [{ container: 5432, host: 9000 }] },
        { ...base.services[1], ports: [{ container: 80, host: 9000, primary: true }] },
      ],
    }) as { ok: false; problems: string[] };
    assert.match(r.problems.join(" "), /both bind host port 9000/);
  });

  test("rejects zero or multiple primary ports", () => {
    const none = validateBlueprint({
      ...base,
      services: [base.services[0], { ...base.services[1], ports: [{ container: 80 }] }],
    }) as { ok: false; problems: string[] };
    assert.match(none.problems.join(" "), /no port marked primary/);

    const two = validateBlueprint({
      ...base,
      services: [
        { ...base.services[0], ports: [{ container: 5432, primary: true }] },
        base.services[1],
      ],
    }) as { ok: false; problems: string[] };
    assert.match(two.problems.join(" "), /more than one port marked primary/);
  });

  test("rejects a blueprint with no proof it works", () => {
    const r = validateBlueprint({ ...base, verify: [] }) as { ok: false; problems: string[] };
    assert.match(r.problems.join(" "), /no verify checks/);
  });

  test("rejects a setup step that names no service", () => {
    const r = validateBlueprint({
      ...base,
      setup: [{ id: "s", label: "s", run: "service", script: "echo hi" }],
    }) as { ok: false; problems: string[] };
    assert.match(r.problems.join(" "), /runs in a service but names none/);
  });

  test("assertBlueprint throws a non-retryable error", () => {
    try {
      assertBlueprint({ id: "bad" });
      assert.fail("should throw");
    } catch (err) {
      assert.ok(err instanceof BlueprintInvalid);
      assert.equal(err.retryable, false);
    }
  });
});

describe("bindings", () => {
  test("lists exactly what is still missing, in user terms", () => {
    const { ok, missing } = checkBindings(odoo, { inputs: {}, seeds: {}, repos: {} });
    assert.equal(ok, false);
    assert.deepEqual(missing.inputs.sort(), ["DB_PASSWORD", "ODOO_DB_NAME"]);
    assert.deepEqual(missing.repos, ["addons"]);
    assert.deepEqual(missing.seeds, [], "the dev database is optional");
  });

  test("optional slots do not block provisioning", () => {
    const { ok } = checkBindings(odoo, {
      inputs: { DB_PASSWORD: "x", ODOO_DB_NAME: "y" },
      seeds: {},
      repos: { addons: ["r"] },
    });
    assert.equal(ok, true);
  });

  test("requirementsOf separates required from optional", () => {
    const req = requirementsOf(odoo);
    assert.ok(req.repos.includes("addons"));
    assert.ok(!req.repos.includes("enterprise"));
  });

  test("compiling without bindings refuses with a readable message", () => {
    try {
      compileProvisioning(odoo, { inputs: {}, seeds: {}, repos: {} });
      assert.fail("should refuse");
    } catch (err) {
      assert.ok(err instanceof BindingsIncomplete);
      assert.match(err.message, /Still needed before setup can start/);
      assert.match(err.message, /DB_PASSWORD/);
    }
  });
});

describe("compose rendering", () => {
  const yaml = renderCompose(odoo, odooBindings, { portBase: 40000 });

  test("interpolates inputs rather than leaking the placeholder", () => {
    assert.ok(yaml.includes('"s3cret"'));
    assert.ok(!yaml.includes("${input."), "no unresolved placeholders reach the VM");
  });

  test("assigns host ports from the session's block", () => {
    assert.ok(yaml.includes('"40000:8069"'));
    assert.ok(yaml.includes('"40001:8072"'));
    assert.equal(primaryPort(odoo, 40000), 40000);
  });

  test("waits for health, not merely for the container to exist", () => {
    assert.match(yaml, /depends_on:\s*\n\s*db:\s*\n\s*condition: service_healthy/);
  });

  test("a dependency without a healthcheck falls back to service_started", () => {
    const bp = assertBlueprint({
      id: "t", version: "1.0.0", name: "T", summary: "t",
      services: [
        { name: "a", image: "busybox" },
        { name: "b", image: "busybox", dependsOn: ["a"], ports: [{ container: 80, primary: true }] },
      ],
      verify: [{ id: "v", label: "v", kind: "port", target: "80" }],
      ui: { whatYouGet: ["Something runs", "You can see it"] },
    });
    const out = renderCompose(bp, { inputs: {}, seeds: {}, repos: {} }, { portBase: 40000 });
    assert.match(out, /condition: service_started/);
  });

  test("interpolate resolves each reference kind", () => {
    assert.equal(interpolate("${input.DB_PASSWORD}", odoo, odooBindings), "s3cret");
    assert.equal(interpolate("${seed.devdb}", odoo, odooBindings), "artifact://dumps/acme.sql");
    assert.equal(interpolate("${repo.addons}", odoo, odooBindings), "acme-addons");
  });
});

describe("provisioning compiles to a durable flow graph", () => {
  test("the graph is linear, guarded, and ends in verification", () => {
    const g = compileProvisioning(odoo, odooBindings);
    assert.equal(g.entry, "acquire");
    const ids = g.nodes.map((n) => n.id);
    assert.deepEqual(ids, [
      "acquire", "repos", "compose", "seed-devdb",
      "setup-write-conf", "setup-module-list", "start", "verify", "bundles",
    ]);
    assert.ok(g.guards?.maxSteps);
    assert.ok(g.guards?.maxWallClockMs);
    assert.equal(g.edges.length, ids.length - 1);
  });

  test("a skipped optional upload drops its step entirely", () => {
    const g = compileProvisioning(odoo, { ...odooBindings, seeds: { devdb: null, filestore: null } });
    assert.ok(!g.nodes.some((n) => n.id.startsWith("seed-")));
  });

  test("the graph passes the flow runtime's own validator once nodes are registered", () => {
    const g = compileProvisioning(odoo, odooBindings);
    const reg = new NodeRegistry();
    // Provisioning node types are registered by the worker; here we only assert the
    // graph's shape is what the runtime expects to be handed.
    const r = reg.validate(g) as { ok: false; problems: string[] };
    assert.equal(r.ok, false);
    assert.ok(
      r.problems.every((p) => /unregistered type "provision\./.test(p)),
      `only unregistered-node complaints expected, got:\n${r.problems.join("\n")}`,
    );
  });

  test("every step has a plain-language label for the non-technical view", () => {
    const g = compileProvisioning(odoo, odooBindings);
    const labels = friendlyStepLabels(odoo);
    for (const n of g.nodes) {
      assert.ok(labels[n.id], `no friendly label for step "${n.id}"`);
      assert.ok(!/docker|compose|container/i.test(labels[n.id]), `jargon in "${labels[n.id]}"`);
    }
  });
});

describe("synthesis: any stack, same artifact", () => {
  const good = {
    id: "django-5-pg", version: "1.0.0", name: "Django 5 + Postgres", summary: "Django with Postgres.",
    services: [
      { name: "db", image: "postgres:16", dataKind: "postgres", healthcheck: { test: "pg_isready -U app" },
        env: { POSTGRES_PASSWORD: "${input.DB_PASSWORD}", POSTGRES_USER: "app", POSTGRES_DB: "app" } },
      { name: "web", image: "python:3.12", dependsOn: ["db"], ports: [{ container: 8000, primary: true }],
        command: "sh -c 'cd /workspace/app && pip install -r requirements.txt && python manage.py runserver 0.0.0.0:8000'" },
    ],
    repos: [{ id: "app", label: "Your Django project", mountPath: "/workspace/app" }],
    inputs: [{ key: "DB_PASSWORD", label: "Database password", secret: true, default: "dev" }],
    verify: [{ id: "up", label: "Site responding", kind: "http", target: "http://localhost:8000/" }],
    ui: { whatYouGet: ["Your Django site running privately", "A preview you can click through"] },
  };

  function modelReturning(...responses: string[]): BlueprintModel {
    let i = 0;
    return { async complete() { return responses[Math.min(i++, responses.length - 1)]; } };
  }

  test("a described stack becomes a validated blueprint", async () => {
    const r = await synthesizeBlueprint(modelReturning(JSON.stringify(good)), {
      text: "Django 5 with Postgres",
    });
    assert.equal(r.attempts, 1);
    assert.equal(r.blueprint.id, "django-5-pg");
    assert.equal(r.blueprint.origin, "synthesized", "origin is forced, not taken from the model");
  });

  test("markdown fences and surrounding prose are tolerated", async () => {
    const r = await synthesizeBlueprint(
      modelReturning("Sure!\n```json\n" + JSON.stringify(good) + "\n```\nHope that helps."),
      { text: "Django" },
    );
    assert.equal(r.blueprint.id, "django-5-pg");
  });

  test("validation problems are fed back and the second attempt is accepted", async () => {
    const broken = { ...good, services: [good.services[0], { ...good.services[1], ports: [{ container: 8000 }] }] };
    const model = modelReturning(JSON.stringify(broken), JSON.stringify(good));
    const r = await synthesizeBlueprint(model, { text: "Django" });
    assert.equal(r.attempts, 2);
    assert.equal(r.repaired.length, 1);
    assert.match(r.repaired[0].join(" "), /no port marked primary/);
  });

  test("it gives up loudly rather than shipping something half-valid", async () => {
    const model = modelReturning(JSON.stringify({ id: "nope" }));
    await assert.rejects(
      () => synthesizeBlueprint(model, { text: "something" }, { maxAttempts: 2 }),
      SynthesisFailed,
    );
  });

  test("non-JSON output is treated as a repairable failure, not a crash", async () => {
    const model = modelReturning("I'm sorry, I can't do that.", JSON.stringify(good));
    const r = await synthesizeBlueprint(model, { text: "Django" });
    assert.equal(r.attempts, 2);
    assert.match(r.repaired[0][0], /not valid JSON/);
  });

  test("the repair prompt names the exact problems and nothing else changes", () => {
    const p = buildPrompt({ text: "Django" }, ["no port marked primary", "ui.whatYouGet is empty"]);
    assert.match(p, /previous attempt was rejected/);
    assert.match(p, /no port marked primary/);
    assert.match(p, /change nothing else/);
  });

  test("repo signals are passed to the model when present", () => {
    const p = buildPrompt({ text: "set this up", detected: { frameworks: ["django"], hasCompose: false } });
    assert.match(p, /Signals detected/);
    assert.match(p, /django/);
  });

  test("a synthesised blueprint needs review; a saved one does not", async () => {
    const r = await synthesizeBlueprint(modelReturning(JSON.stringify(good)), { text: "Django" });
    assert.equal(needsReview(r.blueprint), true, "an environment definition is executable");

    const saved = saveAsTemplate(r.blueprint, { id: "acme-django", name: "Acme Django", approvedBy: "u-admin" });
    assert.equal(saved.origin, "saved");
    assert.equal(needsReview(saved), false);
    assert.ok(saved.tags.includes("saved"));
  });

  test("a synthesised blueprint compiles through the identical pipeline", async () => {
    const r = await synthesizeBlueprint(modelReturning(JSON.stringify(good)), { text: "Django" });
    const g = compileProvisioning(r.blueprint, {
      inputs: { DB_PASSWORD: "x" },
      seeds: {},
      repos: { app: ["my-django"] },
    });
    // Same node vocabulary as the curated Odoo graph: there is no second code path.
    assert.deepEqual(g.nodes.map((n) => n.id), ["acquire", "repos", "compose", "start", "verify", "bundles"]);
    const yaml = renderCompose(r.blueprint, { inputs: { DB_PASSWORD: "x" }, seeds: {}, repos: { app: ["m"] } }, { portBase: 41000 });
    assert.ok(yaml.includes('"41000:8000"'));
  });
});
