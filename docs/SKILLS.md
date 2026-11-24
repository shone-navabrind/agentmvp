# Installed agent skills

Installed with the [`skills` CLI](https://www.npmjs.com/package/skills) at **project scope**:
content lands in `.agents/skills/`, symlinked from `.claude/skills/`, pinned by
`skills-lock.json` (commit SHA + content hash per skill).

```bash
npx skills@latest experimental_install   # restore from the lockfile
npx skills@latest list                   # what is installed
```

Both `.agents/skills/` and `.claude/skills/` are git-ignored — 77 MB across 3,521 files.
`skills-lock.json` is committed, so the set is reproducible without vendoring it.

## What resolved, from the requested list

| Requested | Resolved to | Installed as |
|---|---|---|
| Taste (taste-skill) | `Leonxlnx/taste-skill` | `design-taste-frontend` |
| Impeccable | `pbakaus/impeccable` v4.10.0 | `impeccable` |
| Superpowers | `obra/superpowers` | 15 skills |
| Ponytail | `DietrichGebert/ponytail` | 6 skills |
| Caveman | `JuliusBrussee/caveman` | 22 skills |
| ECC (Everything Claude Code) | `affaan-m/ECC` | **329 skills** |
| Karpathy Skills | `multica-ai/andrej-karpathy-skills` | `karpathy-guidelines` |
| Clean Architecture (nathankim0) | `nathankim0/clean-architecture-skills` | `clean-architecture`, `kent-beck-style` |
| Vercel Agent Skills | `vercel-labs/agent-skills` | 9 skills incl. `web-design-guidelines` |
| Official Code Review & Security | `anthropics/skills` | 20 skills incl. `webapp-testing`, `frontend-design` |
| Anthropic Frontend Design | `anthropics/skills` | `frontend-design` |
| UI/UX Pro Max | `nextlevelbuilder/ui-ux-pro-max-skill` | 6 skills |
| Extract Design System | `arvindrk/extract-design-system` | `extract-design-system` |
| shadcn Skill | `shadcn/ui` | `shadcn`, `migrate-radix-to-base` |
| Playwright CLI (webapp-testing) | `anthropics/skills` | `webapp-testing` |
| Context7 MCP | hosted MCP | `.mcp.json` |
| Playwright MCP | `@playwright/mcp` | `.mcp.json` |

**1386 skills total.** ECC alone is 329 of them — that is the honest cost of installing a
kitchen-sink pack, and it is a large surface of third-party instructions.

## Second pass: the ones that did not resolve first time

Searched individually rather than as a group, which found four more:

| Name | Repo | Note |
|---|---|---|
| Clean Architecture Framework | `wondelai/skills` | 62 skills; scores a design 0-10 against seven diagnostic rows |
| Elephant-Goldfish Model (egm) | `google/elephant-goldfish-model` | Apache 2.0; needs isolated subagents for its Goldfish reviews |
| Software Architecture (davila7) | `davila7/claude-code-templates` | ~900 skills |
| AccessLint | `accesslint/skills` | scan / inspect / audit / fix / diff |
| Vertical slice | `CleanSlice/skills` | nearest equivalent to the Milan Jovanović packs |
| Modular Design Principles | `vladikk/modularity` | Balanced Coupling model |
| claude-mem | `thedotmack/claude-mem` | installs as skills; the runtime tool is separate |

## Still not resolved

- **claude-mem** — `thedotmack/claude-mem` exists but is a *runtime tool* (SQLite + vector
  search, hooks into the session lifecycle), not a `skills`-installable package.
- **Elephant-Goldfish Model (egm)** — no match found.
- **Clean Architecture Framework (`wondelai/skills`)** — repo not found.
- **Vertical Slice & Clean Architecture Packs (Milan Jovanović)** — no Claude skill found;
  his material is blog/course content. `CleanSlice/skills` is the nearest equivalent.
- **Software Architecture (davila7)** — not found under that owner.
- **Modular Design Principles** — too ambiguous to resolve to one repo.
- **Awesome Design** — `rohitg00/awesome-claude-design` is a *prompt collection*
  (DESIGN.md files), not a skill package; the CLI found nothing installable in it.
- **AccessLint** — not found as a skill. Replaced with something better: a real axe-core
  gate (below) that runs against the rendered DOM.
- **Figma MCP** — needs a Figma auth token and the desktop app's local server; nothing to
  configure without credentials.

## Name collisions

Two packs shipped a skill called `taste`. The CLI kept both by renaming:

- `taste` → ECC's, which is about **music-video art direction** (angelcore / hyperpop).
- `design-taste-frontend` → `Leonxlnx/taste-skill`, the frontend one you meant.

Nothing was lost, but `/taste` invokes the music-video one.

## Security notes — read before invoking

Skills are instructions that execute with full agent permissions. Three things in this set
are worth knowing about:

1. **`design-taste-frontend` declares a `Stop` hook** that runs `node scripts/gate.mjs`
   automatically at the end of a turn. It is a third-party script with a 600 s timeout.
2. **ECC's 329 skills were not individually reviewed.** It is a community pack; the lockfile
   pins content hashes, so changes upstream will not land silently, but the initial content
   is trusted on install.
3. **`.mcp.json` adds Context7 and Playwright MCP servers.** Context7 is a hosted remote
   server — queries to it leave this machine.

Scope is per-project, so nothing here affects your other repos.

## What was actually applied to this codebase

Not all 415 were used. These three drove real changes:

- **`web-design-guidelines` (Vercel)** — its bundled Web Interface Guidelines were the
  checklist for the UI pass: focus states, `color-scheme`, `Intl` formatting, URL state,
  tabular numerals, `translate="no"`, touch and reduced-motion handling.
- **`frontend-design` / `impeccable`** — design direction for the pass.
- **`webapp-testing`** — the Playwright-driven verification loop.

### The accessibility gate

`apps/api/src/a11y.test.ts` runs axe-core against the real rendered DOM of all 8 views at
WCAG 2.1 A/AA + best-practice, and **fails the suite on any violation**. It is part of
`npm test`. `npm run a11y` runs the same audit standalone with a readable report.

Baseline when first run: **305 node violations across 4 rules.** Now: **0**.

| Rule | Impact | Nodes | Fix |
|---|---|---|---|
| `color-contrast` | serious | 288 | `--fg-faint` was 3.12:1 on `--bg-raised`. Whole palette re-derived against the worst background; every token now clears 4.5:1. |
| `scrollable-region-focusable` | serious | 8 | `tabindex="0"` on the scrolling surface and status rail. |
| `page-has-heading-one` | moderate | 8 | Visually-hidden `<h1>` in a `<header>` landmark. |
| `empty-table-header` | minor | 1 | The ledger's billing column had no header. |
| `region` | moderate | 8 | Skip link and `<h1>` were outside any landmark. |
| `aria-allowed-role` | minor | 8 | `<header role="tablist">` is not allowed; now a `<div>`. |

Verified the gate can fail: reverting `--fg-faint` to a failing value reproduces 37 contrast
violations per view and reds the suite.
