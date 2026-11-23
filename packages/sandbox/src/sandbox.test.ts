import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "./worktrees.ts";
import { AtCapacity, maxSessionsFor, SessionManager } from "./sessions.ts";

const run = promisify(execFile);

/** A real git repo on disk -- these tests exercise git itself, not a mock. */
async function originRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "hc-origin-"));
  const g = (args: string[]) => run("git", args, { cwd: dir });
  await g(["init", "-q", "-b", "main"]);
  await g(["config", "user.email", "t@example.com"]);
  await g(["config", "user.name", "Test"]);
  await writeFile(join(dir, "README.md"), "# base\n");
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "app.ts"), "export const x = 1;\n");
  await g(["add", "-A"]);
  await g(["commit", "-qm", "base"]);
  return dir;
}

describe("multi-session isolation via git worktrees (real git)", () => {
  test("three sessions get three branches and three independent working copies", async () => {
    const origin = await originRepo();
    const sandbox = await mkdtemp(join(tmpdir(), "hc-sbx-"));
    const wt = new WorktreeManager({
      gitRoot: join(sandbox, "git"),
      workRoot: join(sandbox, "work"),
    });

    await wt.addRepo({ name: "app", remoteUrl: origin, defaultBranch: "main" });
    assert.deepEqual(await wt.repos(), ["app"]);

    const a = await wt.createWorktree("s-alpha", "app");
    const b = await wt.createWorktree("s-beta", "app");
    const c = await wt.createWorktree("s-gamma", "app");

    assert.equal(a.branch, "session/s-alpha");
    assert.notEqual(a.path, b.path);

    // Each session edits the SAME file. Without worktrees this is a corruption bug.
    await writeFile(join(a.path, "src", "app.ts"), "export const x = 'alpha';\n");
    await writeFile(join(b.path, "src", "app.ts"), "export const x = 'beta';\n");
    await writeFile(join(c.path, "src", "app.ts"), "export const x = 'gamma';\n");

    assert.match(await readFile(join(a.path, "src", "app.ts"), "utf8"), /alpha/);
    assert.match(await readFile(join(b.path, "src", "app.ts"), "utf8"), /beta/);
    assert.match(await readFile(join(c.path, "src", "app.ts"), "utf8"), /gamma/);

    const list = await wt.listWorktrees("app");
    const branches = list.map((w) => w.branch).filter((x) => x.startsWith("session/"));
    assert.deepEqual(branches.sort(), ["session/s-alpha", "session/s-beta", "session/s-gamma"]);

    await rm(origin, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true });
  });

  test("diffStat reports what one session changed, not what its neighbours did", async () => {
    const origin = await originRepo();
    const sandbox = await mkdtemp(join(tmpdir(), "hc-sbx-"));
    const wt = new WorktreeManager({ gitRoot: join(sandbox, "git"), workRoot: join(sandbox, "work") });
    await wt.addRepo({ name: "app", remoteUrl: origin, defaultBranch: "main" });

    const a = await wt.createWorktree("s1", "app");
    await wt.createWorktree("s2", "app");
    await writeFile(join(a.path, "src", "app.ts"), "a\nb\nc\n");
    await writeFile(join(a.path, "NEW.md"), "new\n");

    const d1 = await wt.diffStat("s1", "app");
    assert.ok(d1.files >= 1);
    assert.deepEqual(await wt.diffStat("s2", "app"), { files: 0, insertions: 0 });

    await rm(origin, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true });
  });

  test("auto-commit on suspend protects uncommitted work; the remote is the truth", async () => {
    const origin = await originRepo();
    const sandbox = await mkdtemp(join(tmpdir(), "hc-sbx-"));
    const wt = new WorktreeManager({ gitRoot: join(sandbox, "git"), workRoot: join(sandbox, "work") });
    await wt.addRepo({ name: "app", remoteUrl: origin, defaultBranch: "main" });
    const s = await wt.createWorktree("s1", "app");

    assert.equal(await wt.autoCommit("s1", "app", "wip"), null, "nothing to commit");

    await writeFile(join(s.path, "src", "app.ts"), "export const x = 2;\n");
    const sha = await wt.autoCommit("s1", "app", "wip: auto-commit on suspend");
    assert.match(sha ?? "", /^[0-9a-f]{40}$/);
    assert.deepEqual(await wt.diffStat("s1", "app"), { files: 0, insertions: 0 });

    await rm(origin, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true });
  });

  test("archiving prunes the working copy but keeps the branch and its history", async () => {
    const origin = await originRepo();
    const sandbox = await mkdtemp(join(tmpdir(), "hc-sbx-"));
    const wt = new WorktreeManager({ gitRoot: join(sandbox, "git"), workRoot: join(sandbox, "work") });
    await wt.addRepo({ name: "app", remoteUrl: origin, defaultBranch: "main" });
    const s = await wt.createWorktree("s1", "app");
    await writeFile(join(s.path, "f.txt"), "work\n");
    await wt.autoCommit("s1", "app", "keep me");

    await wt.removeWorktree("s1", "app");

    const paths = (await wt.listWorktrees("app")).map((w) => w.path);
    assert.ok(!paths.includes(s.path), "working copy pruned");
    assert.ok((await wt.branches("app")).includes("session/s1"), "branch and history kept");

    await rm(origin, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true });
  });

  test("several repos coexist in one sandbox, each with per-session worktrees", async () => {
    const o1 = await originRepo();
    const o2 = await originRepo();
    const sandbox = await mkdtemp(join(tmpdir(), "hc-sbx-"));
    const wt = new WorktreeManager({ gitRoot: join(sandbox, "git"), workRoot: join(sandbox, "work") });
    await wt.addRepo({ name: "api", remoteUrl: o1, defaultBranch: "main" });
    await wt.addRepo({ name: "web", remoteUrl: o2, defaultBranch: "main" });
    assert.deepEqual(await wt.repos(), ["api", "web"]);

    const api = await wt.createWorktree("s1", "api");
    const web = await wt.createWorktree("s1", "web");
    assert.equal(api.branch, web.branch, "one session, one branch name, across repos");
    assert.notEqual(api.path, web.path);

    await rm(o1, { recursive: true, force: true });
    await rm(o2, { recursive: true, force: true });
    await rm(sandbox, { recursive: true, force: true });
  });
});

describe("session admission control", () => {
  test("concurrency is capped by whichever of memory or CPU binds first", () => {
    // 2 GiB, 2 vCPU: (2048 - 768) / 512 = 2 by memory; 4 by CPU => 2.
    assert.equal(maxSessionsFor({ vcpu: 2, memMiB: 2048 }), 2);
    // 8 GiB, 2 vCPU: 14 by memory, 4 by CPU => 4.
    assert.equal(maxSessionsFor({ vcpu: 2, memMiB: 8192 }), 4);
    // 1 GiB is too small for anything once sandboxd is reserved.
    assert.equal(maxSessionsFor({ vcpu: 2, memMiB: 1024 }), 0);
    // 32 GiB, 8 vCPU: 62 by memory, 16 by CPU => 16, unless the driver caps it lower.
    assert.equal(maxSessionsFor({ vcpu: 8, memMiB: 32768 }), 16);
    assert.equal(maxSessionsFor({ vcpu: 8, memMiB: 32768 }, { driverMax: 8 }), 8, "driver cap wins");
  });

  test("four sessions fit a 4 GiB sandbox; the fifth queues rather than OOMing it", () => {
    const m = new SessionManager({ size: { vcpu: 4, memMiB: 4096 } });
    assert.equal(m.maxSessions, 6);
    for (let i = 0; i < 6; i++) m.transition(m.admit(`s${i}`, "p1").id, "active");
    assert.equal(m.activeCount(), 6);

    const queued = m.admit("s6", "p1");
    assert.equal(queued.state, "queued", "visible as waiting for capacity, not silently dropped");
    assert.equal(m.activeCount(), 6);
  });

  test("suspending a session promotes the next queued one automatically", () => {
    const m = new SessionManager({ size: { vcpu: 1, memMiB: 2048 } });
    assert.equal(m.maxSessions, 2);
    m.transition(m.admit("a", "p1").id, "active");
    m.transition(m.admit("b", "p1").id, "active");
    assert.equal(m.admit("c", "p1").state, "queued");

    m.suspend("a");
    assert.equal(m.get("c")!.state, "starting", "capacity freed, queue drained");
    assert.equal(m.activeCount(), 2);
  });

  test("force admission is refused at capacity with a non-retryable error", () => {
    const m = new SessionManager({ size: { vcpu: 1, memMiB: 2048 } });
    m.transition(m.admit("a", "p1").id, "active");
    m.transition(m.admit("b", "p1").id, "active");
    try {
      m.admit("c", "p1", { force: true });
      assert.fail("should refuse");
    } catch (err) {
      assert.ok(err instanceof AtCapacity);
      assert.equal(err.retryable, false);
      assert.deepEqual(err.details, { active: 2, max: 2 });
    }
  });

  test("each session gets a disjoint port block for its dev servers", () => {
    const m = new SessionManager({ size: { vcpu: 8, memMiB: 16384 }, basePort: 40000 });
    const ranges = ["a", "b", "c"].map((id) => m.admit(id, "p1").portRange);
    assert.deepEqual(ranges, [
      { from: 40000, to: 40009 },
      { from: 40010, to: 40019 },
      { from: 40020, to: 40029 },
    ]);
    const starts = new Set(ranges.map((r) => r.from));
    assert.equal(starts.size, 3, "no two sessions share a port block");
  });

  test("each session runs in its own cgroup scope with hard memory limits", () => {
    const m = new SessionManager({ size: { vcpu: 4, memMiB: 8192 }, perSessionMemMiB: 1024 });
    m.admit("s1", "p1");
    const argv = m.systemdRunArgs("s1", ["pi", "--mode", "rpc"]);
    assert.deepEqual(argv.slice(0, 4), [
      "systemd-run", "--scope", "--unit=hc-session-s1.scope", "--property=MemoryMax=1024M",
    ]);
    assert.ok(argv.includes("--property=MemoryHigh=921M"), "soft limit below the hard one");
    assert.ok(argv.includes("--property=CPUWeight=100"));
    assert.ok(argv.includes("--property=TasksMax=512"), "a fork bomb cannot take the sandbox down");
    assert.deepEqual(argv.slice(-3), ["pi", "--mode", "rpc"]);
  });

  test("the idle reaper finds sessions past the policy window", () => {
    let now = 1_000_000;
    const m = new SessionManager({ size: { vcpu: 8, memMiB: 16384 }, now: () => now });
    m.transition(m.admit("old", "p1").id, "idle");
    now += 60 * 60 * 1000;
    m.transition(m.admit("fresh", "p1").id, "active");

    const stale = m.idleLongerThan(30 * 60 * 1000);
    assert.deepEqual(stale.map((s) => s.id), ["old"]);
  });

  test("archived sessions release their slot", () => {
    const m = new SessionManager({ size: { vcpu: 1, memMiB: 2048 } });
    m.transition(m.admit("a", "p1").id, "active");
    m.transition(m.admit("b", "p1").id, "active");
    assert.equal(m.activeCount(), 2);
    m.archive("a");
    assert.equal(m.activeCount(), 1);
  });
});
