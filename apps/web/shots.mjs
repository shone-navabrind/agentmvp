import { createRequire } from "node:module";
// The repo's workspace node_modules shadows the preinstalled Playwright, so resolve it
// from the toolchain location explicitly.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "/opt/node-tools/node_modules/playwright");
import { mkdir } from "node:fs/promises";

const OUT = process.argv[2] ?? "screenshots";
const BASE = process.env.BASE ?? "http://localhost:8787";

const TABS = [
  ["setup", "01-setup-blueprint"],
  ["chat", "02-session-chat"],
  ["board", "03-board"],
  ["flows", "04-flows"],
  ["triggers", "05-triggers"],
  ["repos", "06-repos"],
  ["terminal", "07-terminal"],
  ["plugins", "08-plugins"],
  ["billing", "09-credits"],
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

await page.goto(BASE + "?role=operator", { waitUntil: "networkidle" });
await page.waitForSelector("#session-list [data-session]", { timeout: 10_000 });

for (const [tab, name] of TABS) {
  await page.click(`.tab[data-tab="${tab}"]`);
  await page.waitForTimeout(220);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}.png`);
}

// Guided role: the same app, far less machinery on screen.
for (const [tab, name] of [["setup", "10-guided-setup"], ["chat", "11-guided-chat"], ["board", "12-guided-board"]]) {
  await page.goto(`${BASE}?role=guided&tab=${tab}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}.png`);
}
await page.goto(BASE + "?role=operator&tab=board", { waitUntil: "networkidle" });
await page.waitForTimeout(250);

// Phone width: the rails collapse out of the way rather than overflowing.
await page.setViewportSize({ width: 430, height: 900 });
await page.waitForTimeout(250);
await page.screenshot({ path: `${OUT}/13-narrow.png` });
console.log("  13-narrow.png");

await browser.close();
console.log(`\n${TABS.length + 2} screenshots written to ${OUT}/`);
