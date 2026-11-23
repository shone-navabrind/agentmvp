import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { KernelError } from "@harness/kernel";

const run = promisify(execFile);

export type GitResult = { stdout: string; stderr: string };

export class GitError extends KernelError {
  constructor(argv: string[], stderr: string) {
    super("GIT_FAILED", `git ${argv.join(" ")} failed: ${stderr.trim()}`, { argv, stderr }, false);
  }
}

async function git(cwd: string, argv: string[]): Promise<GitResult> {
  try {
    return await run("git", argv, { cwd, maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const e = err as { stderr?: string };
    throw new GitError(argv, e.stderr ?? String(err));
  }
}

export type RepoRef = { name: string; remoteUrl: string; defaultBranch: string };

/**
 * Many sessions, one sandbox, N repos.
 *
 * One bare clone per repo plus a worktree per session is what makes concurrency safe:
 * sessions cannot corrupt each other's files, git stays fast because there is a single
 * object store, and "what did this session change" is a diff against the base commit.
 * Promotion to the project's main branch is always explicit -- never implicit.
 */
export class WorktreeManager {
  #gitRoot: string;
  #workRoot: string;

  constructor(opts: { gitRoot: string; workRoot: string }) {
    this.#gitRoot = opts.gitRoot;
    this.#workRoot = opts.workRoot;
  }

  barePath(repo: string): string {
    return join(this.#gitRoot, `${repo}.git`);
  }

  worktreePath(sessionId: string, repo: string): string {
    return join(this.#workRoot, sessionId, repo);
  }

  branchFor(sessionId: string): string {
    return `session/${sessionId}`;
  }

  /** Bare clone, shared by every session in this sandbox. */
  async addRepo(repo: RepoRef): Promise<void> {
    await mkdir(this.#gitRoot, { recursive: true });
    await git(this.#gitRoot, ["clone", "--bare", repo.remoteUrl, `${repo.name}.git`]);
    // A bare clone has no default refspec for fetching all branches; add one.
    await git(this.barePath(repo.name), [
      "config",
      "remote.origin.fetch",
      "+refs/heads/*:refs/heads/*",
    ]);
  }

  async repos(): Promise<string[]> {
    const { stdout } = await run("ls", [this.#gitRoot]).catch(() => ({ stdout: "" }) as GitResult);
    return stdout
      .split("\n")
      .filter((x) => x.endsWith(".git"))
      .map((x) => x.replace(/\.git$/, ""))
      .sort();
  }

  /** Give a session its own branch and working copy of one repo. */
  async createWorktree(
    sessionId: string,
    repo: string,
    opts: { from?: string } = {},
  ): Promise<{ path: string; branch: string }> {
    const path = this.worktreePath(sessionId, repo);
    const branch = this.branchFor(sessionId);
    await mkdir(join(this.#workRoot, sessionId), { recursive: true });
    const base = opts.from ?? "HEAD";
    await git(this.barePath(repo), ["worktree", "add", "-b", branch, path, base]);
    return { path, branch };
  }

  async listWorktrees(repo: string): Promise<Array<{ path: string; branch: string }>> {
    const { stdout } = await git(this.barePath(repo), ["worktree", "list", "--porcelain"]);
    const out: Array<{ path: string; branch: string }> = [];
    let cur: { path?: string; branch?: string } = {};
    for (const line of stdout.split("\n")) {
      if (line.startsWith("worktree ")) cur = { path: line.slice(9) };
      else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "");
      else if (line === "" && cur.path) {
        out.push({ path: cur.path, branch: cur.branch ?? "(detached)" });
        cur = {};
      }
    }
    if (cur.path) out.push({ path: cur.path, branch: cur.branch ?? "(detached)" });
    return out;
  }

  /** What this session changed, relative to where it branched. */
  async diffStat(sessionId: string, repo: string): Promise<{ files: number; insertions: number }> {
    const path = this.worktreePath(sessionId, repo);
    const { stdout } = await git(path, ["diff", "--numstat", "HEAD"]);
    const lines = stdout.split("\n").filter(Boolean);
    return {
      files: lines.length,
      insertions: lines.reduce((n, l) => n + (Number(l.split("\t")[0]) || 0), 0),
    };
  }

  /**
   * Auto-commit on idle/suspend. The sandbox is disposable; the git remote is the source
   * of truth, so uncommitted work is protected by committing it, not by VM snapshots.
   */
  async autoCommit(sessionId: string, repo: string, message: string): Promise<string | null> {
    const path = this.worktreePath(sessionId, repo);
    await git(path, ["add", "-A"]);
    const { stdout: staged } = await git(path, ["diff", "--cached", "--name-only"]);
    if (!staged.trim()) return null;
    await git(path, ["-c", "user.name=harness", "-c", "user.email=harness@local", "commit", "-m", message]);
    const { stdout } = await git(path, ["rev-parse", "HEAD"]);
    return stdout.trim();
  }

  /** Archive a session: prune the working copy, keep the branch and its history. */
  async removeWorktree(sessionId: string, repo: string): Promise<void> {
    const path = this.worktreePath(sessionId, repo);
    await git(this.barePath(repo), ["worktree", "remove", "--force", path]).catch(() => undefined);
    await rm(path, { recursive: true, force: true });
    await git(this.barePath(repo), ["worktree", "prune"]);
  }

  async branches(repo: string): Promise<string[]> {
    const { stdout } = await git(this.barePath(repo), [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ]);
    return stdout.split("\n").filter(Boolean).sort();
  }
}
