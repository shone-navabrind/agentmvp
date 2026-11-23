import { createRequire } from "node:module";
// The repo's workspace node_modules shadows the preinstalled Playwright, so resolve it
// from the toolchain location explicitly.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "/opt/node-tools/node_modules/playwright");
import { mkdir } from "node:fs/promises";

const OUT = process.argv[2] ?? "screenshots";
const BASE = process.env.BASE ?? "http://localhost:8787";

const TABS = [
  ["chat", "01-session-chat"],
  ["board", "02-board"],
  ["flows", "03-flows"],
  ["triggers", "04-triggers"],
  ["repos", "05-repos-worktrees"],
  ["terminal", "06-terminal"],
  ["plugins", "07-plugins"],
  ["billing", "08-credits"],
];

await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 950 },
  deviceScaleFactor: 2,
});

page.on("console", (m) => {
  if (m.type() === "error") console.error("  page error:", m.text());
});
page.on("pageerror", (e) => console.error("  page exception:", e.message));

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForSelector("#session-list [data-session]", { timeout: 10_000 });

for (const [tab, name] of TABS) {
  await page.click(`.tab[data-tab="${tab}"]`);
  await page.waitForTimeout(220);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}.png`);
}

// A second session selected, to show the rail switching and per-session status.
await page.click('#session-list [data-session="s-perf"]');
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/09-second-session.png` });
console.log("  09-second-session.png");

// Phone width: the rails collapse out of the way rather than overflowing.
await page.setViewportSize({ width: 430, height: 900 });
await page.click('.tab[data-tab="board"]');
await page.waitForTimeout(250);
await page.screenshot({ path: `${OUT}/10-narrow.png` });
console.log("  10-narrow.png");

await browser.close();
console.log(`\n${TABS.length + 2} screenshots written to ${OUT}/`);
