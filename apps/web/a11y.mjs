import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

// The repo's workspace node_modules shadows the preinstalled Playwright.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "/opt/node-tools/node_modules/playwright");
const AXE = require.resolve("axe-core/axe.min.js");

const BASE = process.env.BASE ?? "http://localhost:8787";
const TABS = ["chat", "board", "flows", "triggers", "repos", "terminal", "plugins", "billing"];

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector("#session-list li, #session-list button", { timeout: 10_000 });

const axeSource = readFileSync(AXE, "utf8");
const all = new Map();
let total = 0;

for (const tab of TABS) {
  await page.click(`.tab[data-tab="${tab}"]`).catch(() => {});
  await page.waitForTimeout(150);
  await page.evaluate(axeSource);
  const res = await page.evaluate(async () => {
    // WCAG 2.1 A + AA, which is the bar the guidelines target.
    return window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
    });
  });

  for (const v of res.violations) {
    total += v.nodes.length;
    const prev = all.get(v.id) ?? { impact: v.impact, help: v.help, tabs: new Set(), nodes: 0, sample: "" };
    prev.tabs.add(tab);
    prev.nodes += v.nodes.length;
    prev.sample ||= (v.nodes[0]?.html ?? "").slice(0, 110);
    all.set(v.id, prev);
  }
}

await browser.close();

const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
const rows = [...all.entries()].sort(
  (a, b) => (order[a[1].impact] ?? 9) - (order[b[1].impact] ?? 9) || b[1].nodes - a[1].nodes,
);

console.log(`\naxe-core · WCAG 2.1 A/AA + best-practice · ${TABS.length} views\n`);
if (rows.length === 0) {
  console.log("  No violations.\n");
} else {
  for (const [id, v] of rows) {
    console.log(`  [${(v.impact ?? "n/a").padEnd(8)}] ${id}  (${v.nodes} nodes, ${[...v.tabs].join(",")})`);
    console.log(`             ${v.help}`);
    if (v.sample) console.log(`             e.g. ${v.sample}`);
  }
}
console.log(`\n  ${rows.length} distinct rules, ${total} node violations\n`);
process.exit(rows.some(([, v]) => v.impact === "critical" || v.impact === "serious") ? 1 : 0);
