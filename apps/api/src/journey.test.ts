import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { start } from "./server.ts";

const require = createRequire(import.meta.url);
const PW = process.env.PLAYWRIGHT_PATH ?? "/opt/node-tools/node_modules/playwright";

const PORT = 8903;
const BASE = `http://127.0.0.1:${PORT}`;
const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "web", "public");

type Page = {
  goto: (u: string, o?: unknown) => Promise<void>;
  waitForSelector: (s: string, o?: unknown) => Promise<unknown>;
  click: (s: string) => Promise<void>;
  waitForTimeout: (n: number) => Promise<void>;
  textContent: (s: string) => Promise<string | null>;
  $$: (s: string) => Promise<unknown[]>;
  evaluate: <T>(fn: unknown, arg?: unknown) => Promise<T>;
  url: () => string;
  setViewportSize: (s: { width: number; height: number }) => Promise<void>;
};

/**
 * The journey, not the units: a person opens the app, sees what was set up for them,
 * switches how much detail they want, finds the thing waiting on a decision, and the
 * view they are looking at survives a reload.
 *
 * "The process must work" is a claim about the whole path, so it is tested as one.
 */
describe("user journey (real browser)", () => {
  let server: { close: () => Promise<void> };
  let browser: { newPage: (o?: unknown) => Promise<Page>; close: () => Promise<void> } | undefined;
  let page: Page;
  let skipped = false;

  before(async () => {
    server = await start(PORT, webRoot);
    try {
      browser = await require(PW).chromium.launch();
    } catch {
      skipped = true;
      return;
    }
    page = await browser!.newPage({ viewport: { width: 1500, height: 940 } });
  });

  after(async () => {
    await browser?.close();
    await server.close();
  });

  const guard = (t: { skip: (r: string) => void }) => {
    if (skipped) {
      t.skip("no Playwright in this environment");
      return true;
    }
    return false;
  };

  test("a newcomer lands on a working project, not an empty shell", async (t) => {
    if (guard(t)) return;
    await page.goto(`${BASE}?role=guided`, { waitUntil: "networkidle" });
    await page.waitForSelector("#session-list [data-session]", { timeout: 15_000 });

    const tabs = await page.evaluate<string[]>(() =>
      [...document.querySelectorAll(".tab")].map((t) => (t.textContent || "").trim()),
    );
    assert.deepEqual(tabs, ["Get started", "Work", "Tasks"], "guided sees three plain tabs");

    const projects = await page.$$("#project-list .nav-item");
    assert.ok(projects.length >= 1, "a project is already there");
  });

  test("the setup view explains the environment without jargon", async (t) => {
    if (guard(t)) return;
    await page.goto(`${BASE}?role=guided&tab=setup`, { waitUntil: "networkidle" });
    await page.waitForSelector(".gets li", { timeout: 10_000 });

    const body = (await page.textContent(".surface")) ?? "";
    assert.match(body, /Your starting point/);
    assert.match(body, /customer contact details removed/i, "it says what happened to the data");

    for (const word of ["docker", "container", "pg_dump", "localhost", "compose"]) {
      assert.ok(!new RegExp(word, "i").test(body), `guided view leaked the word "${word}"`);
    }
  });

  test("switching to Operator reveals the machinery, same page", async (t) => {
    if (guard(t)) return;
    await page.click('.mode-btn[data-role="operator"]');
    await page.waitForTimeout(250);

    const tabs = await page.evaluate<string[]>(() =>
      [...document.querySelectorAll(".tab")].map((t) => (t.textContent || "").trim()),
    );
    assert.equal(tabs.length, 9, "operator sees every surface");
    assert.ok(tabs.includes("Terminal") && tabs.includes("Credits"));

    const body = (await page.textContent(".surface")) ?? "";
    assert.match(body, /services:/, "the generated compose is now visible");
    assert.ok(!body.includes("dev-only"), "but the secret in it is still redacted");
  });

  test("the thing waiting on a human is findable from the board", async (t) => {
    if (guard(t)) return;
    await page.click('.tab[data-tab="board"]');
    await page.waitForSelector(".card", { timeout: 10_000 });

    const blocked = await page.evaluate<string[]>(() =>
      [...document.querySelectorAll(".card.blocked .card-title")].map((c) => (c.textContent || "").trim()),
    );
    assert.ok(blocked.length >= 1, "a decision is surfaced on the board");
    assert.match(blocked[0], /production/i);
  });

  test("the paused run offers the decision, with its question", async (t) => {
    if (guard(t)) return;
    await page.click('.tab[data-tab="flows"]');
    await page.waitForSelector(".gate", { timeout: 10_000 });

    const q = (await page.textContent(".gate-text")) ?? "";
    assert.match(q, /Release acme\/api #412 to production\?/);

    const actions = await page.evaluate<string[]>(() =>
      [...(document.querySelector(".gate")?.querySelectorAll(".btn") ?? [])].map((b) =>
        (b.textContent || "").trim(),
      ),
    );
    assert.deepEqual(actions, ["approve", "reject"]);

    const steps = await page.evaluate<string[]>(() =>
      [...document.querySelectorAll(".step")].map((s) => (s.className || "").toString()),
    );
    assert.ok(
      steps.some((c) => c.includes("suspended")),
      "the gate reads as waiting, not as failed",
    );
    assert.ok(
      steps.some((c) => c.includes("failed")),
      "and a genuinely failed run is shown differently alongside it",
    );
  });

  test("the view survives a reload, because it lives in the URL", async (t) => {
    if (guard(t)) return;
    assert.match(page.url(), /role=operator/);
    assert.match(page.url(), /tab=flows/);

    await page.goto(page.url(), { waitUntil: "networkidle" });
    await page.waitForSelector(".gate", { timeout: 10_000 });
    const selected = await page.evaluate<string | null>(
      () => document.querySelector('.tab[aria-selected="true"]')?.getAttribute("data-tab") ?? null,
    );
    assert.equal(selected, "flows");
  });

  test("picking a different session changes what the page is about", async (t) => {
    if (guard(t)) return;
    await page.goto(`${BASE}?role=builder&tab=chat`, { waitUntil: "networkidle" });
    await page.waitForSelector("#session-list [data-session]", { timeout: 10_000 });

    await page.click('#session-list [data-session="s-perf"]');
    await page.waitForTimeout(350);

    const heading = (await page.textContent(".page-title")) ?? "";
    assert.match(heading, /Profile the slow query/);
    assert.match(page.url(), /session=s-perf/);
  });

  test("nothing throws into the console on any view", async (t) => {
    if (guard(t)) return;
    const errors: string[] = [];
    const p = (await browser!.newPage({ viewport: { width: 1400, height: 900 } })) as Page & {
      on: (e: string, cb: (x: unknown) => void) => void;
    };
    p.on("console", (m) => {
      const msg = m as { type: () => string; text: () => string };
      if (msg.type() === "error") errors.push(msg.text());
    });
    p.on("pageerror", (e) => errors.push(String(e)));

    for (const tab of ["setup", "chat", "board", "flows", "triggers", "repos", "terminal", "plugins", "billing"]) {
      await p.goto(`${BASE}?role=operator&tab=${tab}`, { waitUntil: "networkidle" });
      await p.waitForTimeout(120);
    }
    assert.deepEqual(errors, [], "a console error is a defect the screenshots cannot show");
  });
});
