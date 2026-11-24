import { icon } from "./icons.js";

const $ = (id) => document.getElementById(id);
/** GET when body is undefined, otherwise POST JSON. Throws the server's own error text. */
async function api(path, body) {
  const r = await fetch(
    path,
    body === undefined
      ? {}
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `${r.status} ${r.statusText}`);
  return data;
}
const get = (p) => api(p);
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
  project: params.get("project"),
  session: params.get("session"),
  creating: false, // the "new project" form is open
  draft: "", // unsent chat text, kept across re-renders
  ws: null,
  data: {},
};
const withP = (p) => `${p}${p.includes("?") ? "&" : "?"}project=${encodeURIComponent(state.project ?? "")}`;

const W = () => ROLES[state.role].words;
const guided = () => state.role === "guided";

function syncUrl() {
  const q = new URLSearchParams({ role: state.role, tab: state.tab });
  if (state.project) q.set("project", state.project);
  if (state.session) q.set("session", state.session);
  history.replaceState(null, "", `${location.pathname}?${q}`);
}

async function load() {
  try {
    const ws = await get("/api/v1/workspace");
    state.ws = ws;
    if (!ws.onboarded) return renderOnboarding();
    $("app").classList.remove("onboarding");
    if (!ws.projects.some((p) => p.id === state.project)) state.project = ws.projects[0].id;

    const [project, sessions, board, flows, triggers, billing, plugins, events, blueprints] =
      await Promise.all(
        ["project", "sessions", "board", "flows", "triggers", "billing", "plugins", "events", "blueprints"]
          .map((r) => get(withP(`/api/v1/${r}`))),
      );
    state.data = { project, sessions, board, flows, triggers, billing, plugins, events, blueprints };
    if (!sessions.some((x) => x.id === state.session)) state.session = sessions[0]?.id ?? null;
    state.data.chat = state.session ? await get(`/api/v1/sessions/${state.session}`) : null;
    syncUrl();
    render();
  } catch (err) {
    $("surface").innerHTML = `<div class="wrap"><h1 class="page-title">Could not load</h1>
      <p class="page-sub err-text">${esc(err.message)}</p>
      <button class="btn" data-action="reload">Try again</button></div>`;
  }
}

/** While the agent is working or a repo is cloning, refresh until it settles. */
let pollTimer;
function schedulePoll() {
  clearTimeout(pollTimer);
  const busy = state.data.chat?.busy || state.data.sessions?.some((x) => x.busy);
  const cloning = state.ws?.projects.some((p) => p.repoStatus === "cloning");
  if (!busy && !cloning) return;
  pollTimer = setTimeout(() => {
    // Never re-render under someone typing into a form.
    const a = document.activeElement;
    if (a && /^(INPUT|SELECT)$/.test(a.tagName)) return schedulePoll();
    load();
  }, busy ? 1500 : 2500);
}

function toast(message) {
  const t = $("toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 7000);
}

function render() {
  const tabs = visibleTabs();
  if (!tabs.includes(state.tab)) state.tab = tabs[0];
  renderRail();
  renderTabs(tabs);
  renderSurface();
  renderStatus();
  schedulePoll();
}

function visibleTabs() {
  return ROLES[state.role].tabs.filter((t) => VIEWER_CAPS.has(TAB_META[t].cap));
}

/* ========================= rail ========================= */
function renderRail() {
  const { project, sessions } = state.data;
  const ws = state.ws;
  $("rail-title").textContent = "Harness Cloud";
  $("ws-name").textContent = ws.workspace;
  $("who-name").textContent = ws.demo ? "shone" : "You";
  $("who-avatar").textContent = ws.demo ? "S" : "Y";
  $("who-role").textContent = ws.demo ? "admin · Navabrind IT" : "local · no sign-in yet";

  const repoSub = (p) =>
    ({ cloning: "cloning repository…", failed: "clone failed", ready: p.repoName, none: "no repository" })[p.repoStatus] ??
    (guided() ? "Ready" : project.harness);
  $("project-list").innerHTML = ws.projects
    .map((p) => ({ id: p.id, name: p.name, state: p.repoStatus === "failed" ? "failed" : "running", sub: repoSub(p) }))
    .map(
      (p) => `<li><button class="nav-item" data-project="${esc(p.id)}" aria-current="${p.id === state.project}">
        <span class="dot ${p.state}" aria-hidden="true"></span>
        <span class="item-main">
          <span class="item-title">${esc(p.name)}</span>
          <span class="item-sub">${esc(p.sub)}</span>
        </span>
        <span class="sr-only">, ${esc(p.state)}</span>
      </button></li>`,
    )
    .join("") +
    (ws.demo ? "" : `<li><button class="nav-item add" data-action="new-project">${icon("plus")}<span class="item-title">New project</span></button></li>`);

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
          <span class="item-sub${guided() ? "" : " code"}" translate="no">${
            s.busy ? "working…" : guided() ? esc(friendlyState(s.state)) : `${esc(s.branch)} · :${s.portRange.from}`
          }</span>
        </span>
        <span class="sr-only">, ${esc(s.state)}</span>
      </button></li>`,
    )
    .join("") +
    (ws.demo ? "" : `<li><button class="nav-item add" data-action="new-session">${icon("plus")}<span class="item-title">New ${esc(W().session.toLowerCase())}</span></button></li>`);

  for (const btn of $("project-list").querySelectorAll("[data-project]")) {
    btn.addEventListener("click", () => {
      state.project = btn.dataset.project;
      state.session = null;
      state.creating = false;
      load();
    });
  }

  for (const btn of $("session-list").querySelectorAll("[data-session]")) {
    btn.addEventListener("click", async () => {
      state.session = btn.dataset.session;
      state.tab = "chat";
      state.creating = false;
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
  $("surface").innerHTML = state.creating ? viewNewProject() : (views[state.tab] ?? viewChat)(state.data);
  const msg = $("msg");
  if (msg) msg.value = state.draft;
}

/* ---- onboarding: the only screen until something exists ---- */
function projectForm(first) {
  return `<form class="form" data-form="project">
      <label>Project name
        <input name="name" required maxlength="80" autocomplete="off" placeholder="my-app" /></label>
      <label>Git repository <span class="opt">optional · public https URL</span>
        <input name="repoUrl" type="url" inputmode="url" placeholder="https://github.com/you/repo.git" /></label>
      <div class="form-actions">
        <button class="btn primary" type="submit">Create project</button>
        ${first ? "" : `<button class="btn" type="button" data-action="cancel-new-project">Cancel</button>`}
      </div>
    </form>`;
}

function agentNote() {
  const a = state.ws?.agent;
  if (!a || a.available) return "";
  return `<p class="note warn-text">${icon("lock")} Agent replies are off: ${esc(a.reason)}</p>`;
}

function renderOnboarding() {
  $("app").classList.add("onboarding");
  $("tabs").innerHTML = "";
  $("mode-switch").innerHTML = "";
  $("status").innerHTML = "";
  $("surface").innerHTML = `<div class="wrap">
    <h1 class="page-title">Create your first project</h1>
    <p class="page-sub">This workspace is empty. A project holds a copy of your code and the agent sessions that work on it. Each session gets its own branch, so sessions never trip over each other.</p>
    ${projectForm(true)}
    ${agentNote()}
  </div>`;
  $("surface").querySelector("input")?.focus();
}

function viewNewProject() {
  return `<div class="wrap">
    <h1 class="page-title">New project</h1>
    <p class="page-sub">A repository is cloned once; every session then works on its own branch of it.</p>
    ${projectForm(false)}
  </div>`;
}

/* ---- setup: the blueprint / onboarding surface ---- */
function viewSetup(d) {
  const bp = d.blueprints;
  const g = guided();
  if (!bp.active) return viewPickBlueprint(bp);

  const gets = bp.active.whatYouGet
    .map((l) => `<li>${icon("check", { size: 17 })}<span>${esc(l)}</span></li>`)
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
    .map((i) =>
      slot(
        "shield",
        i.label,
        i.hint,
        // A secret's value never reaches the browser, so ask the API whether it is set.
        bp.inputsSet?.[i.key] ?? Boolean(bp.bindings.inputs[i.key]),
        i.secret ? "Set" : (bp.bindings.inputs[i.key] ?? ""),
      ),
    )
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
      (c) => `<button class="bp" ${state.ws.demo ? "" : `data-action="choose-blueprint" data-id="${esc(c.id)}"`}>
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
    <h1 class="page-title">${esc(g ? "Your starting point" : bp.active.name)}</h1>
    <p class="page-sub">${esc(
      g && state.ws.demo
        ? "We set this up for you already. Nothing here needs you to know how it works."
        : bp.active.summary,
    )}</p>
    ${
      bp.provisioningBuilt === false
        ? `<p class="note warn-text">Provisioning is not built yet, so nothing below has been run. This is the plan. What works today: the agent in every new session gets this stack's instructions. <button class="btn" data-action="choose-blueprint" data-id="">Remove blueprint</button></p>`
        : ""
    }

    <div class="panel">
      <div class="panel-head">
        <span class="panel-name">${esc(g ? "What you have" : "What this gives you")}</span>
        <span class="pill ${bp.ready ? "ready" : "waiting"}">${
          bp.ready ? "Ready" : bp.provisioningBuilt === false ? "Plan only" : "Needs input"
        }</span>
      </div>
      <ul class="gets">${gets}</ul>
    </div>

    <h2 class="sub">${esc(g ? "What we used" : "Bindings")}</h2>
    <div class="slots">${repoSlots}${seedSlots}${g ? "" : inputSlots}</div>

    <h2 class="sub">${esc(g ? "How it was set up" : "Provisioning plan")}</h2>
    <div class="timeline">${steps}</div>

    ${
      g
        ? ""
        : `<h2 class="sub">Generated compose</h2>
           <pre class="well">${esc(bp.compose.trim())}</pre>`
    }

    <h2 class="sub">${esc(g ? "Other things we can set up" : "Other blueprints")}</h2>
    <div class="bp-grid">
      ${others}
      ${
        state.ws.demo
          ? `<button class="bp">
        <span class="bp-name">${icon("sparkle")} Describe your own</span>
        <span class="bp-sum">Tell us the stack in a sentence — "Django 5 with Postgres and Redis" — and we build and check it before anything runs.</span>
        <span class="bp-foot"><span class="chip plain">Any stack</span></span>
      </button>`
          : ""
      }
    </div>

    <p class="note">${esc(
      !state.ws.demo
        ? "Blueprints describe an environment: services, the data it needs and what the agent should know about the stack."
        : g
        ? "Your data was copied, not moved. Contact details are removed and email sending is switched off, so nothing can reach your real customers."
        : "A catalog blueprint and an AI-synthesised one produce the same validated artifact and run the same provisioning graph. Uploaded dumps are neutralised before the agent sees them.",
    )}</p>
  </div>`;
}

function viewPickBlueprint(bp) {
  const cards = bp.catalog
    .map(
      (c) => `<button class="bp" data-action="choose-blueprint" data-id="${esc(c.id)}">
        <span class="bp-name">${esc(c.name)}</span>
        <span class="bp-sum">${esc(c.summary)}</span>
        <span class="bp-foot">
          <span class="chip plain">${c.services} service${c.services === 1 ? "" : "s"}</span>
          ${(c.tags ?? []).slice(0, 3).map((t) => `<span class="chip plain">${esc(t)}</span>`).join("")}
        </span>
      </button>`,
    )
    .join("");
  return `<div class="wrap-wide">
    <h1 class="page-title">${esc(guided() ? "Pick a starting point" : "Choose a blueprint")}</h1>
    <p class="page-sub">Optional. A blueprint tells the agent which stack it is working in. Provisioning the services themselves is not built yet, so for now it gives the agent context, not a running environment.</p>
    <div class="bp-grid">${cards}</div>
  </div>`;
}

/* ---- chat ---- */
function viewChat(d) {
  const g = guided();
  if (!d.chat) {
    return `<div class="wrap">
      <h1 class="page-title">${esc(g ? "Start a task" : "Start a session")}</h1>
      <p class="page-sub">A session is one conversation with the agent, working on its own ${
        d.project.repos.length ? "branch of your repository" : "scratch folder"
      }. ${esc(d.sessions.length ? "Pick one on the left, or start another." : "There are none yet.")}</p>
      <form class="form" data-form="session">
        <label>What is it about?
          <input name="title" required maxlength="120" autocomplete="off" placeholder="Add a login page" /></label>
        <div class="form-actions"><button class="btn primary" type="submit">Start</button></div>
      </form>
      ${agentNote()}
    </div>`;
  }
  const agentName = g ? "Assistant" : `${d.project.harness} · ${d.project.model}`;
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
      if (e.type === "session.error") {
        return `<div class="activity err-text">${icon("cross")}${esc(e.payload.message)}</div>`;
      }
      const who = e.actor.kind === "user" ? "user" : "agent";
      return `<div class="msg ${who}">
        <div class="msg-avatar">${who === "user" ? "S" : "A"}</div>
        <div class="msg-body">
          <div class="msg-who">${who === "user" ? "You" : esc(agentName)}</div>
          <div class="msg-text">${esc(e.payload.text)}</div>
        </div>
      </div>`;
    })
    .join("");

  return `<div class="wrap">
    <h1 class="page-title">${esc(d.chat.title)}</h1>
    <p class="page-sub">${esc(g ? "Ask for what you need. The assistant works on its own copy." : `Session ${state.session} on ${d.project.model}.`)}</p>
    ${body || `<p class="empty-col">No messages yet.</p>`}
    ${d.chat.busy ? `<div class="activity working">${icon("clock")}Working…</div>` : ""}
    ${
      state.ws.demo
        ? `<div class="composer"><span>The demo is read-only.</span></div>`
        : `<form class="composer" data-form="message">
      <label class="sr-only" for="msg">Message</label>
      <textarea id="msg" name="text" rows="3" required
        placeholder="${esc(g ? "Tell the assistant what you need…" : `Message ${d.project.harness}…  (Enter to send, Shift+Enter for a new line)`)}"
        ${state.ws.agent.available && !d.chat.busy ? "" : "disabled"}></textarea>
      <div class="composer-row">
        <span class="composer-meta" translate="no">${esc(g ? "" : `${state.session} · ${d.project.model}`)}</span>
        <button class="btn primary" type="submit" ${state.ws.agent.available && !d.chat.busy ? "" : "disabled"}>Send</button>
      </div>
    </form>`
    }
    ${agentNote()}
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
        <h2 class="col-head"><span>${esc(names[k])}</span><span class="n">${cards.length}</span></h2>
        ${cards.map(card).join("") || `<p class="empty-col">Nothing here</p>`}
      </div>`;
    })
    .join("");
  return `<div class="wrap-wide">
    <h1 class="page-title">${esc(guided() ? "Tasks" : "Board")}</h1>
    <p class="page-sub">${esc(
      guided()
        ? "Anything in “Needs you” is waiting on a decision only you can make."
        : "A projection of the event log. Cards are raised automatically when a flow run pauses or fails.",
    )}</p>
    ${
      state.ws.demo
        ? ""
        : `<form class="inline-form" data-form="task">
      <label class="sr-only" for="task-title">New task</label>
      <input id="task-title" name="title" required maxlength="200" autocomplete="off" placeholder="Add a task…" />
      <button class="btn primary" type="submit">${icon("plus")}Add</button>
    </form>`
    }
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
  const move = state.ws.demo
    ? ""
    : `<select class="card-move" data-move="${esc(t.task_id)}" aria-label="Move “${esc(t.title)}”">
        ${["todo", "doing", "review", "blocked", "done"]
          .map((s) => `<option value="${s}" ${s === t.state ? "selected" : ""}>${s}</option>`)
          .join("")}
      </select>`;
  return `<div class="card ${t.reason ? "blocked" : ""}">
    <div class="card-title">${esc(t.title)}</div>
    <div class="card-meta">${assignee}${labels}${prs}${reason}</div>
    ${move}
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
    <h1 class="page-title">Flow runs</h1>
    <p class="page-sub">Every node runs on the durable step runtime, so a run killed mid-flight resumes from exactly where it stopped and produces identical output.</p>
    ${runs || `<p class="empty-col">No flow runs yet. The runtime is built, but starting flows from this UI is not wired up yet.</p>`}
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
    <h1 class="page-title">Triggers</h1>
    <p class="page-sub">Events, schedules, inbound webhooks and repository activity all start the same kind of job, so they share concurrency rules, rate limits and a dead-letter queue.</p>
    <table><thead><tr><th>Name</th><th>Source</th><th>Runs</th><th>Overlap</th><th>State</th><th>Fired</th></tr></thead>
    <tbody>${rows}</tbody></table>
    ${rows ? "" : `<p class="empty-col">No triggers. The engine is built, but creating triggers from this UI is not wired up yet.</p>`}
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
        <td class="mono">${esc(r.status ? r.status : r.branch)}${r.error ? `<div class="err-text">${esc(r.error)}</div>` : ""}</td></tr>`,
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
    <h1 class="page-title">${esc(g ? "Your code" : "Repositories")}</h1>
    <p class="page-sub">${esc(
      g
        ? "Each task works on its own copy, so nothing anyone else is doing can break your work."
        : "One bare clone per repo, one worktree per session. Promotion to the main branch is always explicit.",
    )}</p>
    <table><thead><tr><th>Name</th><th>Remote</th><th>${d.project.repos[0]?.status ? "Status" : "Default branch"}</th></tr></thead><tbody>${rows}</tbody></table>
    ${rows ? "" : `<p class="empty-col">No repository attached. Sessions in this project work in their own scratch folder.</p>`}
    <h2 class="sub">${esc(g ? "What each task is working on" : "Session worktrees")}</h2>
    <table><thead><tr><th>${esc(W().session)}</th><th>Branch</th><th>State</th></tr></thead><tbody>${wt}</tbody></table>
  </div>`;
}

/* ---- terminal ---- */
function viewTerminal(d) {
  const cwd = d.chat?.cwd;
  return `<div class="wrap-wide">
    <h1 class="page-title">Terminal</h1>
    <p class="page-sub">Requires the <span class="mono">project:terminal:open</span> capability, granted per user per project.</p>
    <p class="empty-col">The in-browser terminal is not built yet: it needs the sandbox daemon (see docs/STATUS.md).${
      cwd ? ` This session's working copy is at <span class="mono">${esc(cwd)}</span>. Open a shell in it with <span class="mono">docker exec -it harness-cloud bash</span>.` : ""
    }</p>
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
    <h1 class="page-title">Plugins</h1>
    <p class="page-sub">Capabilities are declared in the manifest and enforced at every call. Untrusted plugins never run in the API process, and one that keeps failing is circuit-broken rather than retried.</p>
    <table><thead><tr><th>Plugin</th><th>Trust</th><th>Capabilities</th><th>State</th></tr></thead><tbody>${rows}</tbody></table>
    ${rows ? "" : `<p class="empty-col">No plugins installed. The plugin host is built, but installing plugins from this UI is not wired up yet.</p>`}
  </div>`;
}

/* ---- billing ---- */
function viewBilling(d) {
  const b = d.billing;
  const spent = b.granted * 1e6 - Number(b.balanceMicros);
  const pct = b.granted ? Math.round((spent / (b.granted * 1e6)) * 100) : 0;
  const entries = b.entries
    .map(
      (e) => `<tr><td>${esc(e.kind)}</td><td class="mono">${e.project_id ?? "—"}</td>
      <td class="mono">${usd(e.amount_micros)}</td>
      <td>${e.billable ? "" : '<span class="chip plain">your own key</span>'}</td></tr>`,
    )
    .join("");
  return `<div class="wrap-wide">
    <h1 class="page-title">${esc(W().spend)}</h1>
    <div class="panel">
      <div class="stat-row"><span class="stat-k">Granted</span><span class="stat-v">${money.format(b.granted)}</span></div>
      <div class="stat-row"><span class="stat-k">Spent</span><span class="stat-v">${usd(spent)}</span></div>
      <div class="stat-row"><span class="stat-k">Remaining</span><span class="stat-v">${usd(b.balanceMicros)}</span></div>
      <div class="meter ${pct < 80 ? "ok" : ""}"><i style="width:${Math.min(100, pct)}%"></i></div>
      <div class="stat-row"><span class="stat-k">Ledger drift</span>
        <span class="stat-v ${b.reconcile.drift === 0 ? "ok-text" : "err-text"}">${b.reconcile.drift}</span></div>
    </div>
    ${b.granted ? "" : `<p class="note">No credits granted. Model calls use your own key: they are recorded in the ledger below so you can see the spend, and never charged against credits.</p>`}
    <h2 class="sub">Ledger</h2>
    <table><thead><tr><th>Kind</th><th>Project</th><th>Amount</th><th>Billing</th></tr></thead><tbody>${entries}</tbody></table>
    ${entries ? "" : `<p class="empty-col">Nothing recorded yet.</p>`}
  </div>`;
}

/* ========================= right rail ========================= */
function renderStatus() {
  const d = state.data;
  const p = d.project;
  const b = d.billing;
  const g = guided();
  const sess = d.sessions.find((s) => s.id === state.session);
  const remaining = Number(b.balanceMicros) / 1e6;
  const spentPct = b.granted ? Math.round(((b.granted * 1e6 - Number(b.balanceMicros)) / (b.granted * 1e6)) * 100) : 0;
  // Debits are stored negative; abs() also avoids rendering "-$0.00" when there are none.
  const ownKey = Math.abs(b.entries.filter((e) => !e.billable).reduce((a, e) => a + Number(e.amount_micros), 0)) / 1e6;
  const capPct = (p.capacity.activeSessions / p.capacity.maxSessions) * 100;

  // Each group leads with the one number that answers its question, then supports it.
  const machine = g
    ? `<div class="figure"><span class="n ok-text">Ready</span></div>
       <div class="figure-note">${esc(d.blueprints.active?.name ?? "No starting point chosen")}</div>`
    : `<div class="figure"><span class="n">${p.sandbox.size.vcpu}</span><span class="unit">vCPU</span>
         <span class="n">${(p.sandbox.size.memMiB / 1024).toFixed(0)}</span><span class="unit">GiB</span></div>
       <div class="figure-note">${esc(p.sandbox.state)} · ${esc(p.sandbox.isolation)} isolation</div>
       <div class="stat-row"><span class="stat-k">Blueprint</span><span class="stat-v">${esc(d.blueprints.active?.id ?? "none")}</span></div>
       <div class="stat-row"><span class="stat-k">Driver</span><span class="stat-v">${esc(p.sandbox.driver)}</span></div>`;

  const sessionBlock =
    sess && !g
      ? `<div class="stat-group">
          <div class="stat-head">This ${esc(W().session.toLowerCase())}</div>
          <div class="stat-row"><span class="stat-k">Branch</span><span class="stat-v">${esc(sess.branch)}</span></div>
          <div class="stat-row"><span class="stat-k">Ports</span><span class="stat-v">${sess.portRange.from}\u2013${sess.portRange.to}</span></div>
          <div class="stat-row"><span class="stat-k">Memory cap</span><span class="stat-v">${sess.memMiB} MiB</span></div>
        </div>`
      : "";

  const eventsBlock = g
    ? ""
    : `<div class="stat-group">
        <div class="stat-head">Recent events</div>
        ${d.events.slice(0, 7).map((e) => `<div class="evt"><span class="evt-seq">${esc(e.seq)}</span><span class="evt-type" translate="no">${esc(e.type)}</span></div>`).join("")}
      </div>`;

  $("status").innerHTML = `
    <div class="stat-group">
      <div class="stat-head">${esc(W().sandbox)}</div>
      ${machine}
    </div>

    <div class="stat-group">
      <div class="stat-head">${esc(g ? "Work in progress" : "Sessions")}</div>
      <div class="figure">
        <span class="n">${p.capacity.activeSessions}</span>
        <span class="unit">of ${p.capacity.maxSessions} running</span>
      </div>
      <div class="meter ok"><i style="width:${capPct}%"></i></div>
      ${g ? "" : `<div class="stat-row"><span class="stat-k">Warm pool</span><span class="stat-v">${p.capacity.warmPool}</span></div>`}
    </div>

    ${sessionBlock}

    <div class="stat-group">
      <div class="stat-head">${esc(W().spend)}</div>
      ${
        b.granted
          ? `<div class="figure"><span class="n">${money.format(remaining)}</span></div>
      <div class="figure-note">left of ${money.format(b.granted)}</div>
      <div class="meter ${spentPct < 80 ? "ok" : ""}"><i style="width:${Math.min(100, spentPct)}%"></i></div>`
          : `<div class="figure"><span class="n">${money.format(ownKey)}</span></div>
      <div class="figure-note">recent spend on your own key</div>`
      }
    </div>

    ${eventsBlock}`;
}

/* ========================= actions ========================= */
document.addEventListener("submit", async (ev) => {
  const f = ev.target.closest("form[data-form]");
  if (!f) return;
  ev.preventDefault();
  const data = Object.fromEntries(new FormData(f));
  const button = f.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  try {
    if (f.dataset.form === "project") {
      const p = await api("/api/v1/projects", data);
      Object.assign(state, { project: p.id, session: null, creating: false, tab: "chat" });
    } else if (f.dataset.form === "session") {
      const s = await api("/api/v1/sessions", { project: state.project, title: data.title });
      Object.assign(state, { session: s.id, tab: "chat" });
    } else if (f.dataset.form === "message") {
      await api(`/api/v1/sessions/${state.session}/messages`, { text: data.text });
      state.draft = "";
    } else if (f.dataset.form === "task") {
      await api("/api/v1/board/tasks", { project: state.project, title: data.title });
    }
    await load();
  } catch (err) {
    toast(err.message);
    if (button) button.disabled = false;
  }
});

document.addEventListener("change", async (ev) => {
  const sel = ev.target.closest("select[data-move]");
  if (!sel) return;
  try {
    await api(`/api/v1/board/tasks/${encodeURIComponent(sel.dataset.move)}/move`, { to: sel.value });
    await load();
  } catch (err) {
    toast(err.message);
  }
});

document.addEventListener("input", (ev) => {
  if (ev.target.id === "msg") state.draft = ev.target.value;
});

document.addEventListener("keydown", (ev) => {
  if (ev.target.id === "msg" && ev.key === "Enter" && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    ev.target.form.requestSubmit();
  }
});

document.addEventListener("click", async (ev) => {
  const b = ev.target.closest("[data-action]");
  if (!b) return;
  const action = b.dataset.action;
  try {
    if (action === "reload") return load();
    if (action === "new-project") {
      state.creating = true;
      render();
      $("surface").querySelector("input")?.focus();
    } else if (action === "cancel-new-project") {
      state.creating = false;
      render();
    } else if (action === "new-session") {
      Object.assign(state, { session: null, tab: "chat", creating: false });
      state.data.chat = null;
      syncUrl();
      render();
      $("surface").querySelector("input")?.focus();
    } else if (action === "choose-blueprint") {
      await api(`/api/v1/projects/${encodeURIComponent(state.project)}/blueprint`, { blueprintId: b.dataset.id || null });
      state.tab = "setup";
      await load();
    }
  } catch (err) {
    toast(err.message);
  }
});

load();
