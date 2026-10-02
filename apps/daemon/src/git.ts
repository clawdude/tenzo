import { execFile } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { TenzoError } from "./errors.ts";

/**
 * Variables that point git at a different repository than `cwd`. Git hooks export them, so a
 * tenzo run from inside a hook would otherwise operate on the hook's repo.
 */
const REDIRECTING_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "GIT_PREFIX",
];

export class GitError extends TenzoError {
  override name = "GitError";
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(args: readonly string[], exitCode: number | null, stderr: string) {
    super(`git ${args.join(" ")} failed (exit ${exitCode}): ${stderr.trim() || "no output"}`);
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git in `cwd` and resolves with its exit code and output; rejects only if git can't run. */
export function runGit(cwd: string, args: readonly string[]): Promise<GitResult> {
  const env = { ...process.env };
  for (const key of REDIRECTING_ENV) delete env[key];
  return new Promise((resolvePromise, reject) => {
    execFile("git", args, { cwd, env, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        const missing = error.code === "ENOENT";
        if (missing && !existsSync(cwd)) reject(new TenzoError(`${cwd} does not exist`));
        else reject(missing ? new TenzoError("git is not installed or not on PATH") : error);
        return;
      }
      resolvePromise({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
    });
  });
}

/** Runs git in `cwd` and returns trimmed stdout; throws `GitError` on a non-zero exit. */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) throw new GitError(args, result.code, result.stderr);
  return result.stdout.trim();
}

async function succeeds(cwd: string, args: readonly string[]): Promise<boolean> {
  return (await runGit(cwd, args)).code === 0;
}

/** Resolves `path` to the top level of the git working tree that contains it, symlinks resolved. */
export async function repoRoot(path: string): Promise<string> {
  const absolute = resolve(path);
  if (!existsSync(absolute) || !statSync(absolute).isDirectory()) {
    throw new TenzoError(`${absolute} is not a directory`);
  }
  const result = await runGit(absolute, ["rev-parse", "--show-toplevel"]);
  const top = result.stdout.trim();
  if (result.code !== 0 || top === "") {
    throw new TenzoError(`${absolute} is not inside a git working tree`);
  }
  return realpathSync(top);
}

/**
 * The branch new threads start from: what `origin/HEAD` points at, else a local `main` or
 * `master`, else whatever is checked out.
 */
export async function detectDefaultBranch(root: string): Promise<string> {
  const remote = await runGit(root, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const remoteHead = remote.stdout.trim();
  if (remote.code === 0 && remoteHead.startsWith("origin/"))
    return remoteHead.slice("origin/".length);

  for (const candidate of ["main", "master"]) {
    if (await branchExists(root, candidate)) return candidate;
  }

  const head = await runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (head.code === 0 && head.stdout.trim() !== "") return head.stdout.trim();
  throw new TenzoError(
    `Could not tell the default branch of ${root}: no origin/HEAD, no main or master, and HEAD is detached`,
  );
}

export function branchExists(root: string, branch: string): Promise<boolean> {
  return succeeds(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
}

/** The commit-ish to branch from: the local default branch, else its `origin/` copy. */
export async function resolveBase(root: string, branch: string): Promise<string> {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    if (await succeeds(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])) return ref;
  }
  throw new TenzoError(`The default branch "${branch}" has no commits to start a thread from`);
}

/** Checks out a new branch `branch` from `base` into a new worktree at `path`. */
export async function addWorktree(
  root: string,
  path: string,
  branch: string,
  base: string,
): Promise<void> {
  // --no-track: a thread's branch must not push to the default branch's upstream by accident.
  await git(root, ["worktree", "add", "--no-track", "-b", branch, path, base]);
}

/** True when the worktree at `path` has uncommitted or untracked changes. */
export async function hasChanges(path: string): Promise<boolean> {
  return (await git(path, ["status", "--porcelain"])) !== "";
}

/**
 * Removes the worktree at `path`, keeping its branch. A worktree that is already gone (deleted by
 * hand) is pruned instead, so its stale registration doesn't block git later.
 */
export async function removeWorktree(root: string, path: string, force: boolean): Promise<void> {
  if (!existsSync(path)) {
    await git(root, ["worktree", "prune"]);
    return;
  }
  await git(root, ["worktree", "remove", ...(force ? ["--force"] : []), path]);
}

export async function deleteBranch(root: string, branch: string): Promise<void> {
  await git(root, ["branch", "-D", branch]);
}
