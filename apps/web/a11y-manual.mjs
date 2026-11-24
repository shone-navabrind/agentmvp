import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_PATH ?? "/opt/node-tools/node_modules/playwright");

const BASE = process.env.BASE ?? "http://localhost:8787";

/**
 * The manual tier of an accessibility review: the checks a rule engine cannot decide.
 * axe-core proves a page is lint-clean. This proves it is operable.
 *
 * Each finding is graded by evidence basis, following AccessLint's method:
 *   verified  — the machine saw it happen
 *   confirm   — needs a human to judge (wording, order sensibility)
 *   human     — cannot be automated at all (actual screen-reader output)
 */
const findings = [];
const ledger = [];
const note = (criterion, status, basis, detail) => {
  ledger.push({ criterion, status });
  if (status === "fail") findings.push({ criterion, basis, detail });
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
await page.goto(`${BASE}?role=operator`, { waitUntil: "networkidle" });
await page.waitForSelector("#session-list [data-session]", { timeout: 15_000 });

// ---- 2.1.1 Keyboard: can every interactive element be reached by Tab alone? ----
const reachable = await page.evaluate(async () => {
  const sel =
    'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const all = [...document.querySelectorAll(sel)].filter((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && (r.width > 0 || el.closest(".skip"));
  });
  return all.length;
});

const tabOrder = [];
await page.keyboard.press("Tab");
for (let i = 0; i < reachable + 4; i++) {
  const info = await page.evaluate(() => {
    const el = document.activeElement;
    if (!el || el === document.body) return null;
    return {
      tag: el.tagName.toLowerCase(),
      cls: (el.className || "").toString().split(" ")[0],
      text: (el.textContent || "").trim().slice(0, 28),
      label: el.getAttribute("aria-label") ?? "",
      outline: getComputedStyle(el).outlineStyle,
      outlineWidth: getComputedStyle(el).outlineWidth,
    };
  });
  if (!info) break;
  tabOrder.push(info);
  await page.keyboard.press("Tab");
}

note("2.1.1 Keyboard", tabOrder.length >= reachable - 1 ? "pass" : "fail", "verified",
  `reached ${tabOrder.length} of ${reachable} focusable elements by Tab`);

// ---- 2.4.7 Focus Visible: every stop must paint a ring ----
const noRing = tabOrder.filter((t) => t.outline === "none" || t.outlineWidth === "0px");
note("2.4.7 Focus Visible", noRing.length === 0 ? "pass" : "fail", "verified",
  noRing.length ? `${noRing.length} stops paint no focus ring: ${noRing.map((n) => n.cls).join(", ")}` : "");

// ---- 2.4.3 Focus Order: skip link first, then rail, then tabs, then content ----
const firstStop = tabOrder[0];
note("2.4.3 Focus Order", firstStop?.cls === "skip" ? "pass" : "fail", "confirm",
  firstStop?.cls === "skip" ? "" : `first tab stop is "${firstStop?.cls}", expected the skip link`);

// ---- 4.1.2 Name, Role, Value: every control has an accessible name ----
const unnamed = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("button, a[href], [role='tab']")) {
    const name =
      el.getAttribute("aria-label")?.trim() ||
      el.getAttribute("title")?.trim() ||
      (el.textContent || "").trim();
    if (!name) out.push(el.outerHTML.slice(0, 90));
  }
  return out;
});
note("4.1.2 Name, Role, Value", unnamed.length === 0 ? "pass" : "fail", "verified",
  unnamed.length ? `${unnamed.length} controls with no accessible name: ${unnamed[0]}` : "");

// ---- 2.5.8 Target Size (Minimum): 24x24 CSS px ----
const small = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("button, a[href], [role='tab']")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    if (r.width < 24 || r.height < 24) {
      out.push({
        what: (el.className || el.tagName).toString().split(" ")[0],
        w: Math.round(r.width),
        h: Math.round(r.height),
        text: (el.textContent || "").trim().slice(0, 20),
      });
    }
  }
  return out;
});
note("2.5.8 Target Size", small.length === 0 ? "pass" : "fail", "verified",
  small.length ? small.map((s) => `${s.what}/"${s.text}" ${s.w}x${s.h}`).join("; ") : "");

// ---- 1.4.10 Reflow: 320 CSS px wide, no horizontal scroll ----
await page.setViewportSize({ width: 320, height: 800 });
await page.waitForTimeout(220);
const reflow = await page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
}));
note("1.4.10 Reflow", reflow.scrollW <= reflow.clientW + 1 ? "pass" : "fail", "verified",
  `scrollWidth ${reflow.scrollW} vs clientWidth ${reflow.clientW} at 320px`);

// ---- 1.4.4 Resize Text: 200% zoom, still no horizontal scroll ----
await page.setViewportSize({ width: 800, height: 900 });
await page.evaluate(() => { document.documentElement.style.fontSize = "200%"; });
await page.waitForTimeout(220);
const zoomed = await page.evaluate(() => ({
  scrollW: document.documentElement.scrollWidth,
  clientW: document.documentElement.clientWidth,
}));
note("1.4.4 Resize Text", zoomed.scrollW <= zoomed.clientW + 1 ? "pass" : "fail", "verified",
  `scrollWidth ${zoomed.scrollW} vs clientWidth ${zoomed.clientW} at 200% text`);
await page.evaluate(() => { document.documentElement.style.fontSize = ""; });

// ---- 2.3.3 Animation from Interactions: honour prefers-reduced-motion ----
await page.setViewportSize({ width: 1600, height: 950 });
await page.emulateMedia({ reducedMotion: "reduce" });
await page.goto(`${BASE}?role=operator&tab=setup`, { waitUntil: "networkidle" });
await page.waitForTimeout(200);
const motion = await page.evaluate(() => {
  const el = document.querySelector(".tl");
  if (!el) return { found: false, duration: "0s" };
  return { found: true, duration: getComputedStyle(el).animationDuration };
});
note("2.3.3 Animation from Interactions",
  !motion.found || parseFloat(motion.duration) < 0.05 ? "pass" : "fail", "verified",
  motion.found ? `timeline animation runs ${motion.duration} under reduced motion` : "");

// ---- 1.3.1 Info and Relationships: heading hierarchy has no skipped level ----
const headings = await page.evaluate(() =>
  [...document.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((h) => Number(h.tagName[1])),
);
let skipped = null;
for (let i = 1; i < headings.length; i++) {
  if (headings[i] > headings[i - 1] + 1) skipped = `h${headings[i - 1]} -> h${headings[i]}`;
}
note("1.3.1 Info and Relationships", skipped ? "fail" : "pass", "verified",
  skipped ? `heading level skipped: ${skipped}` : "");

await browser.close();

// ---- report ----
console.log("\nAccessibility · manual tier · WCAG 2.2\n");
for (const l of ledger) {
  console.log(`  ${l.status === "pass" ? "pass" : "FAIL"}  ${l.criterion}`);
}
if (findings.length) {
  console.log("\nFindings\n");
  for (const f of findings) console.log(`  [${f.basis}] ${f.criterion}\n          ${f.detail}`);
}
console.log(`\n  ${ledger.filter((l) => l.status === "pass").length}/${ledger.length} criteria verified`);
console.log("  Not automatable, still owed to a human: actual screen-reader output,");
console.log("  whether focus order matches visual order, and whether labels read sensibly.\n");
process.exit(findings.length ? 1 : 0);
