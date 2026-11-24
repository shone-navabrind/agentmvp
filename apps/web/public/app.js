import { icon } from "./icons.js";

const $ = (id) => document.getElementById(id);
const get = (p) => fetch(p).then((r) => r.json());
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
const usd = (micros) => money.format(Number(micros) / 1e6);

/**
 * Roles do not change what the product can do — they change how much machinery is on
 * screen and what it is called. One shell, one API, one set of capabilities.
 */
const ROLES = {
  guided: {
    label: "Guided",
    blurb: "Plain language. The technical detail is still there if you ask for it.",
    tabs: ["setup", "chat", "board"],
    words: {
      setup: "Get started",
      chat: "Work",
      board: "Tasks",
      sandbox: "Your machine",
      session: "Task",
      sessions: "Tasks in progress",
      blueprint: "Starting point",
      spend: "Budget",
    },
  },
  builder: {
    label: "Builder",
    blurb: "The everyday view: work, tasks, code and previews.",
    tabs: ["setup", "chat", "board", "repos", "flows"],
    words: {
      setup: "Setup",
      chat: "Session",
      board: "Board",
      flows: "Flows",
      repos: "Repos",
      sandbox: "Environment",
      session: "Session",
      sessions: "Sessions",
      blueprint: "Blueprint",
      spend: "Spend",
    },
  },
  operator: {
    label: "Operator",
    blurb: "Everything, including the parts that can break production.",
    tabs: ["setup", "chat", "board", "flows", "triggers", "repos", "terminal", "plugins", "billing"],
    words: {
      setup: "Blueprint",
      chat: "Session",
      board: "Board",
      flows: "Flows",
      triggers: "Triggers",
      repos: "Repos",
      terminal: "Terminal",
      plugins: "Plugins",
      billing: "Credits",
      sandbox: "Sandbox",
      session: "Session",
      sessions: "Sessions",
      blueprint: "Blueprint",
      spend: "Spend",
    },
  },
};

const TAB_META = {
  setup: { icon: "blueprint", cap: "project:read" },
  chat: { icon: "session", cap: "project:chat" },
  board: { icon: "board", cap: "project:read" },
  flows: { icon: "flow", cap: "project:read" },
  triggers: { icon: "trigger", cap: "project:read" },
  repos: { icon: "repo", cap: "project:read" },
  terminal: { icon: "terminal", cap: "project:terminal:open" },
  plugins: { icon: "plugin", cap: "plugin:install" },
  billing: { icon: "credits", cap: "workspace:budget:manage" },
};

const VIEWER_CAPS = new Set([
  "project:read", "project:chat", "project:files:write",
  "project:terminal:open", "workspace:budget:manage", "plugin:install",
]);

const params = new URLSearchParams(location.search);
const state = {
  role: params.get("role") ?? "builder",
  tab: params.get("tab") ?? "chat",
  session: params.get("session") ?? "s-auth",
  data: {},
};

const W = () => ROLES[state.role].words;
const guided = () => state.role === "guided";

function syncUrl() {
  const q = new URLSearchParams({ role: state.role, tab: state.tab, session: state.session });
  history.replaceState(null, "", `${location.pathname}?${q}`);
}

async function load() {
  const [project, sessions, board, flows, triggers, billing, plugins, events, blueprints] =
    await Promise.all([
      get("/api/v1/project"), get("/api/v1/sessions"), get("/api/v1/board"),
      get("/api/v1/flows"), get("/api/v1/triggers"), get("/api/v1/billing"),
      get("/api/v1/plugins"), get("/api/v1/events"), get("/api/v1/blueprints"),
    ]);
  state.data = { project, sessions, board, flows, triggers, billing, plugins, events, blueprints };
  state.data.chat = await get(`/api/v1/sessions/${state.session}`);
  render();
}

function render() {
  const tabs = visibleTabs();
  if (!tabs.includes(state.tab)) state.tab = tabs[0];
  renderRail();
  renderTabs(tabs);
  renderSurface();
  renderStatus();
}

function visibleTabs() {
  return ROLES[state.role].tabs.filter((t) => VIEWER_CAPS.has(TAB_META[t].cap));
}

/* ========================= rail ========================= */
function renderRail() {
  const { project, sessions } = state.data;
  $("rail-title").textContent = "Harness Cloud";

  $("project-list").innerHTML = [
    { id: "p1", name: project.name, state: "running", sub: guided() ? "Ready" : project.harness },
    { id: "p2", name: "acme-docs", state: "suspended", sub: guided() ? "Asleep" : "idle 4h" },
    { id: "p3", name: "data-pipeline", state: "stopped", sub: guided() ? "Off" : "stopped" },
  ]
    .map(
      (p) => `<li><button class="nav-item" aria-current="${p.id === "p1"}">
        <span class="dot ${p.state}" aria-hidden="true"></span>
        <span class="item-main">
          <span class="item-title">${esc(p.name)}</span>
          <span class="item-sub">${esc(p.sub)}</span>
        </span>
        <span class="sr-only">, ${esc(p.state)}</span>
      </button></li>`,
    )
    .join("");

  $("sessions-head-text").textContent = W().sessions;
  $("capacity").textContent = guided()
    ? ""
    : `${project.capacity.activeSessions}/${project.capacity.maxSessions}`;

  $("session-list").innerHTML = sessions
    .map(
      (s) => `<li><button class="nav-item" data-session="${esc(s.id)}"
          aria-current="${s.id === state.session}">
        <span class="dot ${s.state}" aria-hidden="true"></span>
        <span class="item-main">
          <span class="item-title">${esc(s.title)}</span>
          <span class="item-sub">${
            guided()
              ? esc(friendlyState(s.state))
              : `<span translate="no">${esc(s.branch)}</span> · :${s.portRange.from}`
          }</span>
        </span>
        <span class="sr-only">, ${esc(s.state)}</span>
      </button></li>`,
    )
    .join("");

  for (const btn of $("session-list").querySelectorAll("[data-session]")) {
    btn.addEventListener("click", async () => {
      state.session = btn.dataset.session;
      state.tab = "chat";
      syncUrl();
      state.data.chat = await get(`/api/v1/sessions/${state.session}`);
      render();
    });
  }
}

function friendlyState(s) {
  return { active: "Working now", idle: "Paused", queued: "Waiting its turn", suspended: "Asleep", archived: "Finished" }[s] ?? s;
}

/* ========================= tabs ========================= */
function renderTabs(tabs) {
  const w = W();
  $("tabs").innerHTML = tabs
    .map((t) => {
      const on = state.tab === t;
      return `<button class="tab ${on ? "on" : ""}" role="tab" aria-selected="${on}"
        aria-controls="surface" data-tab="${t}">${icon(TAB_META[t].icon)}${esc(w[t] ?? t)}</button>`;
    })
    .join("");

  $("mode-switch").innerHTML = Object.entries(ROLES)
    .map(
      ([k, r]) =>
        `<button class="mode-btn" data-role="${k}" aria-pressed="${state.role === k}"
           title="${esc(r.blurb)}">${esc(r.label)}</button>`,
    )
    .join("");

  for (const b of $("tabs").querySelectorAll(".tab")) {
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab;
      syncUrl();
      render();
    });
  }
  for (const b of $("mode-switch").querySelectorAll(".mode-btn")) {
    b.addEventListener("click", () => {
      state.role = b.dataset.role;
      syncUrl();
      render();
    });
  }
}

/* ========================= surface ========================= */
function renderSurface() {
  const views = {
    setup: viewSetup, chat: viewChat, board: viewBoard, flows: viewFlows,
    triggers: viewTriggers, repos: viewRepos, terminal: viewTerminal,
    plugins: viewPlugins, billing: viewBilling,
  };
  $("surface").innerHTML = (views[state.tab] ?? viewChat)(state.data);
}

/* ---- setup: the blueprint / onboarding surface ---- */
function viewSetup(d) {
  const bp = d.blueprints;
  const g = guided();

  const gets = bp.active.whatYouGet
    .map((l) => `<li>${icon("check")}<span>${esc(l)}</span></li>`)
    .join("");

  const needs = bp.catalog.find((c) => c.id === bp.active.id)?.needs ?? { repos: [], seeds: [], inputs: [] };
  const slot = (iconName, label, hint, filled, detail) => `
    <div class="slot">
      ${icon(iconName)}
      <span class="slot-main">
        <span class="slot-label">${esc(label)}</span>
        <span class="slot-hint">${esc(hint ?? "")}</span>
      </span>
      <span class="slot-state">${
        filled
          ? `<span class="pill ready">${icon("check", { size: 12 })} ${esc(detail)}</span>`
          : `<span class="pill waiting">Not set</span>`
      }</span>
    </div>`;

  const repoSlots = needs.repos
    .map((r) => slot("repo", r.label, r.hint, (bp.bindings.repos[r.id] ?? []).length > 0, (bp.bindings.repos[r.id] ?? []).join(", ")))
    .join("");
  const seedSlots = needs.seeds
    .map((s) =>
      slot(
        "upload",
        s.label,
        g && s.scrubs.length ? `${s.hint} ` : s.hint,
        Boolean(bp.bindings.seeds[s.id]),
        "Uploaded",
      ),
    )
    .join("");
  const inputSlots = needs.inputs
    .map((i) => slot("shield", i.label, i.hint, Boolean(bp.bindings.inputs[i.key]), i.secret ? "Set" : esc(bp.bindings.inputs[i.key] ?? "")))
    .join("");

  const steps = bp.steps
    .map(
      (s, idx) =>
        `<div class="tl" style="animation-delay:${idx * 40}ms">${icon("check")}<span>${esc(s.label)}</span></div>`,
    )
    .join("");

  const others = bp.catalog
    .filter((c) => c.id !== bp.active.id)
    .map(
      (c) => `<button class="bp">
        <span class="bp-name">${esc(c.name)}</span>
        <span class="bp-sum">${esc(c.summary)}</span>
        <span class="bp-foot">
          <span class="chip plain">${c.services} service${c.services === 1 ? "" : "s"}</span>
          <span class="chip plain">~${c.estimateMinutes} min</span>
        </span>
      </button>`,
    )
    .join("");

  return `<div class="wrap-wide">
    <h2 class="sec">${esc(g ? "Your starting point" : bp.active.name)}</h2>
    <p class="sec-note">${esc(
      g
        ? "We set this up for you already. Nothing here needs you to know how it works."
        : bp.active.summary,
    )}</p>

    <div class="panel">
      <div class="panel-head">
        <span class="panel-name">${esc(g ? "What you have" : "What this gives you")}</span>
        <span class="pill ${bp.ready ? "ready" : "waiting"}">${
          bp.ready ? "Ready" : "Needs input"
        }</span>
      </div>
      <ul class="gets">${gets}</ul>
    </div>

    <h3 class="sub">${esc(g ? "What we used" : "Bindings")}</h3>
    <div class="slots">${repoSlots}${seedSlots}${g ? "" : inputSlots}</div>

    <h3 class="sub">${esc(g ? "How it was set up" : "Provisioning plan")}</h3>
    <div class="timeline">${steps}</div>

    ${
      g
        ? ""
        : `<h3 class="sub">Generated compose</h3>
           <pre class="well">${esc(bp.compose.trim())}</pre>`
    }

    <h3 class="sub">${esc(g ? "Other things we can set up" : "Other blueprints")}</h3>
    <div class="bp-grid">
      ${others}
      <button class="bp">
        <span class="bp-name">${icon("sparkle")} Describe your own</span>
        <span class="bp-sum">Tell us the stack in a sentence — "Django 5 with Postgres and Redis" — and we build and check it before anything runs.</span>
        <span class="bp-foot"><span class="chip plain">Any stack</span></span>
      </button>
    </div>

    <p class="note">${esc(
      g
        ? "Your data was copied, not moved. Contact details are removed and email sending is switched off, so nothing can reach your real customers."
        : "A catalog blueprint and an AI-synthesised one produce the same validated artifact and run the same provisioning graph. Uploaded dumps are neutralised before the agent sees them.",
    )}</p>
  </div>`;
}

/* ---- chat ---- */
function viewChat(d) {
  const g = guided();
  const body = d.chat.events
    .map((e) => {
      if (e.type === "session.started") {
        return g
          ? ""
          : `<div class="activity">${icon("check")}Session started on <span class="mono">${esc(e.payload.branch)}</span></div>`;
      }
      if (e.type === "tool.ran") {
        return `<div class="activity">${icon("check")}${esc(e.payload.summary)}</div>`;
      }
      const who = e.actor.kind === "user" ? "user" : "agent";
      return `<div class="msg ${who}">
        <div class="msg-avatar">${who === "user" ? "S" : "A"}</div>
        <div class="msg-body">
          <div class="msg-who">${who === "user" ? "You" : g ? "Assistant" : "pi · claude-sonnet-5-5"}</div>
          <div class="msg-text">${esc(e.payload.text)}</div>
        </div>
      </div>`;
    })
    .join("");

  return `<div class="wrap">
    <h2 class="sec">${esc(d.chat.title)}</h2>
    ${body}
    <div class="composer">
      <span>${esc(g ? "Tell the assistant what you need…" : "Reply to pi…")}</span>
      <span class="composer-meta" translate="no">${esc(
        g ? "" : `${state.session} · ${d.project.model}`,
      )}</span>
    </div>
  </div>`;
}

/* ---- board ---- */
function viewBoard(d) {
  const order = ["todo", "doing", "review", "blocked", "done"];
  const names = guided()
    ? { todo: "To do", doing: "In progress", review: "Ready to check", blocked: "Needs you", done: "Done" }
    : { todo: "todo", doing: "doing", review: "review", blocked: "blocked", done: "done" };
  const cols = order
    .map((k) => {
      const cards = d.board.columns[k] ?? [];
      return `<div>
        <h3 class="col-head"><span>${esc(names[k])}</span><span>${cards.length}</span></h3>
        ${cards.map(card).join("") || `<p class="empty-col">Nothing here</p>`}
      </div>`;
    })
    .join("");
  return `<div class="wrap-wide">
    <h2 class="sec">${esc(guided() ? "Tasks" : "Board")}</h2>
    <p class="sec-note">${esc(
      guided()
        ? "Anything in “Needs you” is waiting on a decision only you can make."
        : "A projection of the event log. Blocked cards were raised automatically by paused or failed runs.",
    )}</p>
    <div class="board">${cols}</div>
  </div>`;
}

function card(t) {
  const g = guided();
  const assignee = t.assignee
    ? `<span class="chip ${t.assignee.startsWith("agent") ? "agent" : "user"}">${esc(
        g ? (t.assignee.startsWith("agent") ? "Assistant" : "You") : t.assignee,
      )}</span>`
    : "";
  const labels = g ? "" : (t.labels ?? []).map((l) => `<span class="chip">${esc(l)}</span>`).join("");
  const prs = (t.pr_urls ?? [])
    .map((u) => `<span class="chip pr">${esc(g ? "Change ready" : `PR #${u.split("/").pop()}`)}</span>`)
    .join("");
  const reason = t.reason ? `<span class="chip warn">${esc(g ? "Your decision" : t.reason)}</span>` : "";
  return `<div class="card ${t.reason ? "blocked" : ""}">
    <div class="card-title">${esc(t.title)}</div>
    <div class="card-meta">${assignee}${labels}${prs}${reason}</div>
  </div>`;
}

/* ---- flows ---- */
function viewFlows(d) {
  const mark = { completed: "check", failed: "cross", ambiguous: "cross", suspended: "pause" };
  const runs = d.flows.runs
    .map((r) => {
      const steps = (r.steps ?? [])
        .map(
          (s, i) =>
            `${i ? `<span class="arrow">${icon("chevron", { size: 12 })}</span>` : ""}` +
            `<span class="step ${s.state}">${icon(mark[s.state] ?? "dot", { size: 12 })}${esc(s.step_key)}</span>`,
        )
        .join("");
      const gate = r.state === "paused" ? pausedGate(d, r.id) : "";
      const err =
        r.state === "failed" && r.error
          ? `<p class="note err-text">${esc(r.error.code ?? "")} — ${esc(r.error.message ?? "")}</p>`
          : "";
      return `<div class="panel">
        <div class="panel-head">
          <span class="panel-name">${esc(r.kind)}</span>
          <span class="pill ${r.state}">${esc(r.state)}</span>
        </div>
        <div class="steps">${steps || '<span class="step">no steps yet</span>'}</div>
        ${gate}${err}
      </div>`;
    })
    .join("");
  return `<div class="wrap-wide">
    <h2 class="sec">Flow runs</h2>
    <p class="sec-note">Every node runs on the durable step runtime, so a run killed mid-flight resumes from exactly where it stopped and produces identical output.</p>
    ${runs}
  </div>`;
}

function pausedGate(d, runId) {
  const a = d.flows.awaiting.find((x) => x.id === runId);
  if (!a?.question) return "";
  const opts = (a.question.options ?? ["approve", "reject"])
    .map((o, i) => `<button class="btn ${i === 0 ? "primary" : ""}">${esc(o)}</button>`)
    .join("");
  return `<div class="gate">
    <div class="gate-text">${esc(a.question.text)}</div>
    <div class="gate-actions">${opts}</div>
  </div>`;
}

/* ---- triggers ---- */
function viewTriggers(d) {
  const rows = d.triggers
    .map(
      (t) => `<tr>
      <td>${esc(t.name)}<div class="mono">${esc(t.id)}</div></td>
      <td class="mono">${esc(describeSource(t.source))}</td>
      <td class="mono">${esc(t.action.flowKind ?? t.action.type)}</td>
      <td>${esc(t.concurrency)}</td>
      <td><span class="pill ${t.enabled ? "active" : "off"}">${t.enabled ? "on" : "off"}</span></td>
      <td class="mono">${t.firings}</td>
    </tr>`,
    )
    .join("");
  return `<div class="wrap-wide">
    <h2 class="sec">Triggers</h2>
    <p class="sec-note">Events, schedules, inbound webhooks and repository activity all start the same kind of job, so they share concurrency rules, rate limits and a dead-letter queue.</p>
    <table><thead><tr><th>Name</th><th>Source</th><th>Runs</th><th>Overlap</th><th>State</th><th>Fired</th></tr></thead>
    <tbody>${rows}</tbody></table>
  </div>`;
}

function describeSource(s) {
  if (s.kind === "event") return `event ${s.match}`;
  if (s.kind === "cron") return `cron ${s.expression}`;
  if (s.kind === "webhook") return `webhook /${s.token}`;
  return `repo ${s.repo}`;
}

/* ---- repos ---- */
function viewRepos(d) {
  const g = guided();
  const rows = d.project.repos
    .map(
      (r) => `<tr><td>${esc(r.name)}</td><td class="mono">${esc(r.remote)}</td>
        <td class="mono">${esc(r.branch)}</td></tr>`,
    )
    .join("");
  const wt = d.sessions
    .map(
      (s) => `<tr>
      <td>${esc(s.title)}</td>
      <td class="mono">${esc(s.branch)}</td>
      <td><span class="pill ${s.state}">${esc(g ? friendlyState(s.state) : s.state)}</span></td>
    </tr>`,
    )
    .join("");
  return `<div class="wrap-wide">
    <h2 class="sec">${esc(g ? "Your code" : "Repositories")}</h2>
    <p class="sec-note">${esc(
      g
        ? "Each task works on its own copy, so nothing anyone else is doing can break your work."
        : "One bare clone per repo, one worktree per session. Promotion to the main branch is always explicit.",
    )}</p>
    <table><thead><tr><th>Name</th><th>Remote</th><th>Default branch</th></tr></thead><tbody>${rows}</tbody></table>
    <h3 class="sub">${esc(g ? "What each task is working on" : "Session worktrees")}</h3>
    <table><thead><tr><th>${esc(W().session)}</th><th>Branch</th><th>State</th></tr></thead><tbody>${wt}</tbody></table>
  </div>`;
}

/* ---- terminal ---- */
function viewTerminal(d) {
  const sess = d.sessions.find((s) => s.id === state.session) ?? d.sessions[0];
  return `<div class="wrap-wide">
    <h2 class="sec">Terminal · ${esc(sess.title)}</h2>
    <p class="sec-note">Requires the <span class="mono">project:terminal:open</span> capability, granted per user per project. Every session is recorded and audited.</p>
    <pre class="well"><span class="prompt">root@${esc(d.project.sandbox.id)}:/work/${esc(sess.id)}/addons$</span> git status --short
 M models/sale_order.py
 M views/sale_view.xml
<span class="prompt">root@${esc(d.project.sandbox.id)}:/work/${esc(sess.id)}/addons$</span> docker compose ps
NAME   IMAGE        STATUS
db     postgres:16  Up (healthy)
odoo   odoo:18      Up (healthy)
<span class="prompt">root@${esc(d.project.sandbox.id)}:/work/${esc(sess.id)}/addons$</span> <span class="cursor"> </span></pre>
  </div>`;
}

/* ---- plugins ---- */
function viewPlugins(d) {
  const rows = d.plugins
    .map(
      (p) => `<tr>
      <td>${esc(p.id)} <span class="mono">${esc(p.version)}</span>
        <div class="slot-hint">${esc(p.description)}</div></td>
      <td><span class="chip plain">${esc(p.trust)}</span> <span class="chip plain">${esc(p.runtime)}</span></td>
      <td class="mono">${p.capabilities.map(esc).join("<br>") || "—"}</td>
      <td><span class="pill ${p.state}">${esc(p.state)}</span>
        ${p.failures ? `<div class="mono err-text">${p.failures} failures</div>` : ""}</td>
    </tr>`,
    )
    .join("");
  return `<div class="wrap-wide">
    <h2 class="sec">Plugins</h2>
    <p class="sec-note">Capabilities are declared in the manifest and enforced at every call. Untrusted plugins never run in the API process, and one that keeps failing is circuit-broken rather than retried.</p>
    <table><thead><tr><th>Plugin</th><th>Trust</th><th>Capabilities</th><th>State</th></tr></thead><tbody>${rows}</tbody></table>
  </div>`;
}

/* ---- billing ---- */
function viewBilling(d) {
  const b = d.billing;
  const spent = b.granted * 1e6 - Number(b.balanceMicros);
  const pct = Math.round((spent / (b.granted * 1e6)) * 100);
  const entries = b.entries
    .map(
      (e) => `<tr><td>${esc(e.kind)}</td><td class="mono">${e.project_id ?? "—"}</td>
      <td class="mono">${usd(e.amount_micros)}</td>
      <td>${e.billable ? "" : '<span class="chip plain">your own key</span>'}</td></tr>`,
    )
    .join("");
  return `<div class="wrap-wide">
    <h2 class="sec">${esc(W().spend)}</h2>
    <div class="panel">
      <div class="stat-row"><span class="stat-k">Granted</span><span class="stat-v">${money.format(b.granted)}</span></div>
      <div class="stat-row"><span class="stat-k">Spent</span><span class="stat-v">${usd(spent)}</span></div>
      <div class="stat-row"><span class="stat-k">Remaining</span><span class="stat-v">${usd(b.balanceMicros)}</span></div>
      <div class="meter ${pct < 80 ? "ok" : ""}"><i style="width:${Math.min(100, pct)}%"></i></div>
      <div class="stat-row"><span class="stat-k">Ledger drift</span>
        <span class="stat-v ${b.reconcile.drift === 0 ? "ok-text" : "err-text"}">${b.reconcile.drift}</span></div>
    </div>
    <h3 class="sub">Ledger</h3>
    <table><thead><tr><th>Kind</th><th>Project</th><th>Amount</th><th>Billing</th></tr></thead><tbody>${entries}</tbody></table>
  </div>`;
}

/* ========================= right rail ========================= */
function renderStatus() {
  const d = state.data;
  const p = d.project;
  const b = d.billing;
  const g = guided();
  const sess = d.sessions.find((s) => s.id === state.session);
  const spentPct = Math.round(((b.granted * 1e6 - Number(b.balanceMicros)) / (b.granted * 1e6)) * 100);

  const machine = g
    ? `<div class="stat-row"><span class="stat-k">State</span><span class="stat-v ok-text">Ready</span></div>
       <div class="stat-row"><span class="stat-k">Running</span><span class="stat-v">${esc(d.blueprints.active.name)}</span></div>`
    : `<div class="stat-row"><span class="stat-k">State</span><span class="stat-v ok-text">${esc(p.sandbox.state)}</span></div>
       <div class="stat-row"><span class="stat-k">Blueprint</span><span class="stat-v">${esc(d.blueprints.active.id)}</span></div>
       <div class="stat-row"><span class="stat-k">Driver</span><span class="stat-v">${esc(p.sandbox.driver)}</span></div>
       <div class="stat-row"><span class="stat-k">Isolation</span><span class="stat-v">${esc(p.sandbox.isolation)}</span></div>
       <div class="stat-row"><span class="stat-k">Size</span><span class="stat-v">${p.sandbox.size.vcpu} vCPU · ${p.sandbox.size.memMiB} MiB</span></div>`;

  const sessionBlock =
    sess && !g
      ? `<div class="stat-group">
          <div class="stat-head">This ${esc(W().session.toLowerCase())}</div>
          <div class="stat-row"><span class="stat-k">Branch</span><span class="stat-v">${esc(sess.branch)}</span></div>
          <div class="stat-row"><span class="stat-k">Ports</span><span class="stat-v">${sess.portRange.from}–${sess.portRange.to}</span></div>
          <div class="stat-row"><span class="stat-k">Memory cap</span><span class="stat-v">${sess.memMiB} MiB</span></div>
        </div>`
      : "";

  const eventsBlock = g
    ? ""
    : `<div class="stat-group">
        <div class="stat-head">Recent events</div>
        ${d.events.slice(0, 8).map((e) => `<div class="evt"><span class="evt-seq">${esc(e.seq)}</span><span class="evt-type" translate="no">${esc(e.type)}</span></div>`).join("")}
      </div>`;

  $("status").innerHTML = `
    <div class="stat-group">
      <div class="stat-head">${esc(W().sandbox)}</div>
      ${machine}
    </div>

    <div class="stat-group">
      <div class="stat-head">${esc(g ? "Capacity" : "Sessions")}</div>
      <div class="stat-row"><span class="stat-k">${esc(g ? "Tasks running" : "Active")}</span>
        <span class="stat-v">${p.capacity.activeSessions} / ${p.capacity.maxSessions}</span></div>
      <div class="meter ok"><i style="width:${(p.capacity.activeSessions / p.capacity.maxSessions) * 100}%"></i></div>
    </div>

    ${sessionBlock}

    <div class="stat-group">
      <div class="stat-head">${esc(W().spend)}</div>
      <div class="stat-row"><span class="stat-k">Remaining</span><span class="stat-v">${usd(b.balanceMicros)}</span></div>
      <div class="meter ${spentPct < 80 ? "ok" : ""}"><i style="width:${Math.min(100, spentPct)}%"></i></div>
      <div class="stat-row"><span class="stat-k">of ${money.format(b.granted)}</span><span class="stat-v">${spentPct}% used</span></div>
    </div>

    ${eventsBlock}`;
}

syncUrl();
load();
