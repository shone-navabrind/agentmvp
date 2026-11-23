const $ = (id) => document.getElementById(id);
const get = (p) => fetch(p).then((r) => r.json());
const esc = (s) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const money = new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" });
const usd = (micros) => money.format(Number(micros) / 1e6);

const params = new URLSearchParams(location.search);
const state = {
  tab: params.get("tab") ?? "chat",
  session: params.get("session") ?? "s-auth",
  data: {},
};

function syncUrl() {
  const q = new URLSearchParams({ tab: state.tab, session: state.session });
  history.replaceState(null, "", `${location.pathname}?${q}`);
}

// Capability-driven rendering: one UI, tabs appear only if the viewer may use them.
// The viewer here is an admin, so the terminal is unlocked.
const TABS = [
  { id: "chat", label: "Session", cap: "project:chat" },
  { id: "board", label: "Board", cap: "project:read" },
  { id: "flows", label: "Flows", cap: "project:read" },
  { id: "triggers", label: "Triggers", cap: "project:read" },
  { id: "repos", label: "Repos", cap: "project:read" },
  { id: "terminal", label: "Terminal", cap: "project:terminal:open" },
  { id: "plugins", label: "Plugins", cap: "project:read" },
  { id: "billing", label: "Credits", cap: "workspace:budget:manage" },
];
const VIEWER_CAPS = new Set([
  "project:read", "project:chat", "project:files:write",
  "project:terminal:open", "workspace:budget:manage",
]);

async function load() {
  const [project, sessions, board, flows, triggers, billing, plugins, events, authz] =
    await Promise.all([
      get("/api/v1/project"), get("/api/v1/sessions"), get("/api/v1/board"),
      get("/api/v1/flows"), get("/api/v1/triggers"), get("/api/v1/billing"),
      get("/api/v1/plugins"), get("/api/v1/events"), get("/api/v1/authz"),
    ]);
  state.data = { project, sessions, board, flows, triggers, billing, plugins, events, authz };
  state.data.chat = await get(`/api/v1/sessions/${state.session}`);
  render();
}

function render() {
  renderRail();
  renderTabs();
  renderSurface();
  renderStatus();
}

function renderRail() {
  const { project, sessions } = state.data;
  $("project-list").innerHTML = [
    { id: "p1", name: project.name, state: "running", sub: project.harness },
    { id: "p2", name: "acme-docs", state: "suspended", sub: "idle 4h" },
    { id: "p3", name: "data-pipeline", state: "stopped", sub: "stopped" },
  ]
    .map(
      (p) => `<li>
        <button class="nav-item" aria-current="${p.id === "p1"}">
          <span class="dot ${p.state}" aria-hidden="true"></span>
          <span class="item-main">
            <span class="item-title">${esc(p.name)}</span>
            <span class="item-sub">${esc(p.sub)}</span>
          </span>
          <span class="sr-only">, ${esc(p.state)}</span>
        </button>
      </li>`,
    )
    .join("");

  $("capacity").textContent = `${project.capacity.activeSessions}/${project.capacity.maxSessions}`;
  $("session-list").innerHTML = sessions
    .map(
      (s) => `<li>
        <button class="nav-item" data-session="${esc(s.id)}"
                aria-current="${s.id === state.session}">
          <span class="dot ${s.state}" aria-hidden="true"></span>
          <span class="item-main">
            <span class="item-title">${esc(s.title)}</span>
            <span class="item-sub"><span translate="no">${esc(s.branch)}</span> · :${s.portRange.from}</span>
          </span>
          <span class="sr-only">, ${esc(s.state)}</span>
        </button>
      </li>`,
    )
    .join("");

  // Real <button>s, so Enter/Space, focus order and the accessible name all come
  // from the platform rather than a hand-rolled keydown handler on an <li>.
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

function renderTabs() {
  $("tabs").innerHTML = TABS.map((t) => {
    const allowed = VIEWER_CAPS.has(t.cap);
    const on = state.tab === t.id;
    const lock = allowed
      ? ""
      : `<span class="tab-lock" aria-hidden="true">\u{1F512}</span>` +
        `<span class="sr-only">, requires the ${t.cap} capability</span>`;
    return `<button class="tab ${on ? "on" : ""} ${allowed ? "" : "locked"}"
      role="tab" aria-selected="${on}" aria-controls="surface"
      data-tab="${t.id}" ${allowed ? "" : 'disabled aria-disabled="true"'}>${t.label}${lock}</button>`;
  }).join("");
  for (const b of $("tabs").querySelectorAll(".tab")) {
    b.addEventListener("click", () => {
      state.tab = b.dataset.tab;
      syncUrl();
      render();
    });
  }
}

function renderSurface() {
  const s = $("surface");
  const d = state.data;
  const views = {
    chat: () => viewChat(d),
    board: () => viewBoard(d),
    flows: () => viewFlows(d),
    triggers: () => viewTriggers(d),
    repos: () => viewRepos(d),
    terminal: () => viewTerminal(d),
    plugins: () => viewPlugins(d),
    billing: () => viewBilling(d),
  };
  s.innerHTML = (views[state.tab] ?? views.chat)();
}

function viewChat(d) {
  const title = d.chat.title;
  const body = d.chat.events
    .map((e) => {
      if (e.type === "session.started") {
        return `<div class="tool"><span class="tick">▸</span> Session started on <span class="mono">${esc(e.payload.branch)}</span></div>`;
      }
      if (e.type === "tool.ran") {
        return `<div class="tool"><span class="tick">✓</span> ${esc(e.payload.summary)}</div>`;
      }
      const who = e.actor.kind === "user" ? "user" : "agent";
      return `<div class="msg ${who}">
        <div class="msg-avatar">${who === "user" ? "S" : "pi"}</div>
        <div class="msg-body">
          <div class="msg-who">${who === "user" ? "shone" : "pi · claude-sonnet-5-5"}</div>
          <div class="msg-text">${esc(e.payload.text)}</div>
        </div>
      </div>`;
    })
    .join("");

  return `<h2 class="sec">${esc(title)}</h2>${body}
    <div class="composer">
      <span>Reply to pi…</span>
      <span class="composer-meta" translate="no">${esc(state.session)} · ${esc(d.project.model)}</span>
    </div>
    <div class="note">Tool activity is shown as friendly summaries. Raw tool calls, VM names
      and IPs are never rendered for members — this view is capability-filtered, not a
      separate app.</div>`;
}

function viewBoard(d) {
  const order = ["todo", "doing", "review", "blocked", "done"];
  const cols = order
    .map((state_) => {
      const cards = d.board.columns[state_] ?? [];
      return `<div>
        <h3 class="col-head"><span>${state_}</span><span>${cards.length}</span></h3>
        ${cards.map(card).join("") || `<p class="empty-col">Nothing in ${state_}</p>`}
      </div>`;
    })
    .join("");
  return `<h2 class="sec">Board · acme-platform</h2><div class="board">${cols}</div>
    <div class="note">The board is a projection of the event log, not a separate datastore.
      Blocked cards with a reason were raised automatically by paused or failed flow runs —
      this is the human-in-the-loop inbox.</div>`;
}

function card(t) {
  const labels = (t.labels ?? []).map((l) => `<span class="chip label">${esc(l)}</span>`).join("");
  const assignee = t.assignee
    ? `<span class="chip ${t.assignee.startsWith("agent") ? "agent" : "user"}">${esc(t.assignee)}</span>`
    : "";
  const prs = (t.pr_urls ?? [])
    .map((u) => `<span class="chip pr">PR #${esc(u.split("/").pop())}</span>`)
    .join("");
  const reason = t.reason ? `<span class="chip warn">${esc(t.reason)}</span>` : "";
  return `<div class="card ${t.reason ? "blocked" : ""}">
    <div class="card-title">${esc(t.title)}</div>
    <div class="card-meta">${assignee}${labels}${prs}${reason}</div>
  </div>`;
}

function viewFlows(d) {
  const runs = d.flows.runs
    .map((r) => {
      const steps = (r.steps ?? [])
        .map(
          (s, i) =>
            `${i ? '<span class="arrow">→</span>' : ""}<span class="step ${s.state}">${
              { completed: "✓", failed: "✕", ambiguous: "!", suspended: "⏸" }[s.state] ?? "•"
            } ${esc(s.step_key)}</span>`,
        )
        .join("");
      const q = r.state === "paused" ? pausedQuestion(d, r.id) : "";
      // A paused run carries a SUSPEND_RUN "error" that is not an error; only show
      // the red note for a genuinely failed run.
      const err =
        r.state === "failed" && r.error
          ? `<div class="note err-text">${esc(r.error.code ?? "")} — ${esc(r.error.message ?? "")}</div>`
          : "";
      return `<div class="run">
        <div class="run-head">
          <span class="run-name">${esc(r.kind)}</span>
          <span class="pill ${r.state}">${r.state}</span>
        </div>
        <div class="steps">${steps || '<span class="step pending">no steps yet</span>'}</div>
        ${q}${err}
      </div>`;
    })
    .join("");
  return `<h2 class="sec">Flow runs</h2>${runs}
    <div class="note">Every node runs through the kernel's step runtime, so each completed
      step is memoised: a run that is killed mid-flight resumes from exactly here and
      produces identical output. Guards (maxSteps, maxCostUsd, stall detection) are
      required on any graph containing a cycle.</div>`;
}

function pausedQuestion(d, runId) {
  const a = d.flows.awaiting.find((x) => x.id === runId);
  if (!a?.question) return "";
  const opts = (a.question.options ?? ["approve", "reject"])
    .map((o, i) => `<button class="btn ${i === 0 ? "primary" : ""}">${esc(o)}</button>`)
    .join("");
  return `<div class="question">
    <div class="q-text">${esc(a.question.text)}</div>
    <div class="q-actions">${opts}</div>
  </div>`;
}

function viewTriggers(d) {
  const rows = d.triggers
    .map(
      (t) => `<tr>
      <td>${esc(t.name)}<div class="mono" style="color:var(--fg-faint)">${esc(t.id)}</div></td>
      <td class="mono">${esc(describeSource(t.source))}</td>
      <td class="mono">${esc(t.action.flowKind ?? t.action.type)}</td>
      <td>${esc(t.concurrency)}</td>
      <td><span class="pill ${t.enabled ? "active" : "off"}">${t.enabled ? "enabled" : "disabled"}</span></td>
      <td class="mono">${t.firings}</td>
    </tr>`,
    )
    .join("");
  return `<h2 class="sec">Triggers</h2>
    <table><thead><tr><th>Name</th><th>Source</th><th>Action</th><th>Concurrency</th><th>State</th><th>Firings</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="note">Events, cron, inbound webhooks and repo events all produce the same
      thing — a job on the step runtime — so they share concurrency policy, rate limiting,
      a dead-letter queue and one correlation id you can trace end to end.</div>`;
}

function describeSource(s) {
  if (s.kind === "event") return `event ${s.match}`;
  if (s.kind === "cron") return `cron ${s.expression}`;
  if (s.kind === "webhook") return `webhook /${s.token}`;
  return `repo ${s.repo}`;
}

function viewRepos(d) {
  const rows = d.project.repos
    .map(
      (r) => `<tr>
      <td>${esc(r.name)}</td>
      <td class="mono">${esc(r.remote)}</td>
      <td class="mono">${esc(r.branch)}</td>
      <td class="mono">/srv/git/${esc(r.name)}.git</td>
    </tr>`,
    )
    .join("");
  const wt = d.sessions
    .map(
      (s) => `<tr>
      <td>${esc(s.title)}</td>
      <td class="mono">${esc(s.branch)}</td>
      <td class="mono">/work/${esc(s.id)}/</td>
      <td><span class="pill ${s.state}">${s.state}</span></td>
    </tr>`,
    )
    .join("");
  return `<h2 class="sec">Repositories</h2>
    <table><thead><tr><th>Name</th><th>Remote</th><th>Default</th><th>Bare clone</th></tr></thead><tbody>${rows}</tbody></table>
    <h2 class="sec">Session worktrees</h2>
    <table><thead><tr><th>Session</th><th>Branch</th><th>Worktree</th><th>State</th></tr></thead><tbody>${wt}</tbody></table>
    <div class="note">One bare clone per repo, one git worktree per session. Sessions edit the
      same files without colliding, git stays fast on a single object store, and promotion to
      the project's main branch is always explicit. Uncommitted work is auto-committed on
      suspend: the sandbox is disposable, the git remote is the source of truth.</div>`;
}

function viewTerminal(d) {
  const sess = d.sessions.find((s) => s.id === state.session) ?? d.sessions[0];
  return `<h2 class="sec">Terminal · ${esc(sess.title)}</h2>
    <div class="run"><div class="mono" style="line-height:1.7">
      <div style="color:var(--fg-faint)">root@${esc(d.project.sandbox.id)}:/work/${esc(sess.id)}/api$ git status --short</div>
      <div> M src/auth/oauth.ts</div>
      <div> M src/routes/login.tsx</div>
      <div style="color:var(--fg-faint)">root@${esc(d.project.sandbox.id)}:/work/${esc(sess.id)}/api$ systemd-cgls ${esc(sess.cgroupScope)}</div>
      <div>${esc(sess.cgroupScope)} (MemoryMax=${sess.memMiB}M, CPUWeight=${sess.cpuWeight})</div>
      <div>└─ 2 processes</div>
      <div style="color:var(--fg-faint)">root@${esc(d.project.sandbox.id)}:/work/${esc(sess.id)}/api$ <span style="background:var(--fg);color:var(--bg)">&nbsp;</span></div>
    </div></div>
    <div class="note warn-text">This tab requires the <span class="mono">project:terminal:open</span>
      capability, granted per user per project. Every session is recorded and audited with
      actor, project and start/end. A member without the grant does not see this tab at all.</div>`;
}

function viewPlugins(d) {
  const rows = d.plugins
    .map(
      (p) => `<tr>
      <td>${esc(p.id)} <span class="mono" style="color:var(--fg-faint)">${esc(p.version)}</span>
        <div style="color:var(--fg-faint);font-size:11px">${esc(p.description)}</div></td>
      <td><span class="chip">${esc(p.trust)}</span> <span class="chip">${esc(p.runtime)}</span></td>
      <td class="mono">${p.provides.map((x) => esc(x.point)).join("<br>")}</td>
      <td class="mono">${p.capabilities.map(esc).join("<br>") || "—"}</td>
      <td><span class="pill ${p.state}">${p.state}</span>
        ${p.failures ? `<div class="mono err-text" style="font-size:10.5px">${p.failures} failures</div>` : ""}
        ${p.lastError ? `<div class="mono" style="font-size:10px;color:var(--fg-faint)">${esc(p.lastError)}</div>` : ""}
      </td>
    </tr>`,
    )
    .join("");
  return `<h2 class="sec">Plugins</h2>
    <table><thead><tr><th>Plugin</th><th>Trust</th><th>Extension points</th><th>Capabilities</th><th>State</th></tr></thead>
    <tbody>${rows}</tbody></table>
    <div class="note">Capabilities are declared in the manifest, shown here at install, and
      enforced at every call — a plugin cannot reach a host or read a secret it did not
      declare. Untrusted plugins may never run in the API process. A plugin that keeps
      failing is circuit-broken and disappears from its extension point; the host keeps serving.</div>`;
}

function viewBilling(d) {
  const b = d.billing;
  const spent = b.granted * 1e6 - Number(b.balanceMicros);
  const pct = Math.round((spent / (b.granted * 1e6)) * 100);
  const entries = b.entries
    .map(
      (e) => `<tr>
      <td>${esc(e.kind)}</td>
      <td class="mono">${e.project_id ?? "—"}</td>
      <td class="mono">${usd(e.amount_micros)}</td>
      <td>${e.billable ? '<span class="chip">charged</span>' : '<span class="chip">BYOK · not charged</span>'}</td>
      <td class="mono" style="color:var(--fg-faint)">${esc(e.idem_key)}</td>
    </tr>`,
    )
    .join("");
  const alerts = (b.alerts ?? [])
    .map((a) => `<div class="note warn-text">Budget alert: ${a.level}% of credit consumed.</div>`)
    .join("");
  return `<h2 class="sec">Credits</h2>
    <div class="run">
      <div class="stat-row"><span class="stat-k">Granted</span><span class="stat-v">$${b.granted.toFixed(2)}</span></div>
      <div class="stat-row"><span class="stat-k">Spent</span><span class="stat-v">${usd(spent)}</span></div>
      <div class="stat-row"><span class="stat-k">Remaining</span><span class="stat-v">${usd(b.balanceMicros)}</span></div>
      <div class="meter ${pct < 80 ? "ok" : ""}"><i style="width:${Math.min(100, pct)}%"></i></div>
      <div class="stat-row"><span class="stat-k">Gateway cap on sk-proj-p1</span>
        <span class="stat-v">$${(b.gatewayBudgets["sk-proj-p1"] ?? 0).toFixed(2)}</span></div>
      <div class="stat-row"><span class="stat-k">Ledger drift</span>
        <span class="stat-v ${b.reconcile.drift === 0 ? "ok-text" : "err-text"}">${b.reconcile.drift} µ$</span></div>
    </div>
    ${alerts}
    <h2 class="sec">Ledger</h2>
    <table><thead><tr><th>Kind</th><th>Project</th><th>Amount</th><th>Billing</th><th>Idempotency key</th></tr></thead>
    <tbody>${entries}</tbody></table>
    <div class="note">Append-only, in USD micro-units, with idempotency keys: a replayed
      spend-sync cannot double-charge. The gateway's own cap is set to the remaining balance,
      so it refuses at zero rather than the platform discovering the overspend later.</div>`;
}

function renderStatus() {
  const d = state.data;
  const p = d.project;
  const b = d.billing;
  const spentPct = Math.round(((b.granted * 1e6 - Number(b.balanceMicros)) / (b.granted * 1e6)) * 100);
  const sess = d.sessions.find((s) => s.id === state.session);

  const authzRows = d.authz
    .map(
      (a) => `<div class="stat-row">
        <span class="stat-k">${esc(a.subject)}</span>
        <span class="stat-v">${Object.values(a.decisions).filter(Boolean).length}/${Object.keys(a.decisions).length}</span>
      </div>`,
    )
    .join("");

  const events = d.events
    .slice(0, 9)
    .map(
      (e) => `<div class="evt">
        <span class="evt-seq">${esc(e.seq)}</span>
        <span class="evt-type" translate="no">${esc(e.type)}</span>
      </div>`,
    )
    .join("");

  $("status").innerHTML = `
    <div class="stat-group">
      <div class="stat-head">Sandbox</div>
      <div class="stat-row"><span class="stat-k">State</span><span class="stat-v ok-text">${esc(p.sandbox.state)}</span></div>
      <div class="stat-row"><span class="stat-k">Driver</span><span class="stat-v">${esc(p.sandbox.driver)}</span></div>
      <div class="stat-row"><span class="stat-k">Isolation</span><span class="stat-v">${esc(p.sandbox.isolation)}</span></div>
      <div class="stat-row"><span class="stat-k">Size</span><span class="stat-v">${p.sandbox.size.vcpu} vCPU · ${p.sandbox.size.memMiB} MiB</span></div>
      <div class="stat-row"><span class="stat-k">Image</span><span class="stat-v">${esc(p.imageVersion)}</span></div>
      <div class="stat-row"><span class="stat-k">From warm pool</span><span class="stat-v">${p.sandbox.fromWarmPool ? "yes" : "no"}</span></div>
    </div>

    <div class="stat-group">
      <div class="stat-head">Capacity</div>
      <div class="stat-row"><span class="stat-k">Sessions</span><span class="stat-v">${p.capacity.activeSessions} / ${p.capacity.maxSessions}</span></div>
      <div class="meter ok"><i style="width:${(p.capacity.activeSessions / p.capacity.maxSessions) * 100}%"></i></div>
      <div class="stat-row"><span class="stat-k">Warm pool</span><span class="stat-v">${p.capacity.warmPool}</span></div>
      <div class="stat-row"><span class="stat-k">Host free</span><span class="stat-v">${p.capacity.hostFree.vcpu} vCPU · ${(p.capacity.hostFree.memMiB / 1024).toFixed(0)} GiB</span></div>
    </div>

    ${
      sess
        ? `<div class="stat-group">
      <div class="stat-head">This session</div>
      <div class="stat-row"><span class="stat-k">Branch</span><span class="stat-v">${esc(sess.branch)}</span></div>
      <div class="stat-row"><span class="stat-k">Ports</span><span class="stat-v">${sess.portRange.from}–${sess.portRange.to}</span></div>
      <div class="stat-row"><span class="stat-k">cgroup</span><span class="stat-v">${sess.memMiB} MiB</span></div>
      <div class="stat-row"><span class="stat-k">State</span><span class="stat-v">${esc(sess.state)}</span></div>
    </div>`
        : ""
    }

    <div class="stat-group">
      <div class="stat-head">Spend</div>
      <div class="stat-row"><span class="stat-k">Remaining</span><span class="stat-v">${usd(b.balanceMicros)}</span></div>
      <div class="meter ${spentPct < 80 ? "ok" : ""}"><i style="width:${Math.min(100, spentPct)}%"></i></div>
      <div class="stat-row"><span class="stat-k">of $${b.granted.toFixed(0)} granted</span><span class="stat-v">${spentPct}% used</span></div>
    </div>

    <div class="stat-group">
      <div class="stat-head">Capabilities granted</div>
      ${authzRows}
    </div>

    <div class="stat-group">
      <div class="stat-head">Recent events</div>
      ${events}
    </div>`;
}

syncUrl();
load();
