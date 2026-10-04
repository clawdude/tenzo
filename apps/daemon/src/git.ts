import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { TenzoError } from "./errors.ts";

/**
 * Variables that point git at a different repository than `cwd`. Git hooks export them, so a
 * tenzo run from inside a hook would otherwise operate on the hook's repo.
 */
export const REDIRECTING_ENV = [
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

export interface RunGitOptions {
  /** Kill git (and its helpers) if it hasn't finished by then, and reject with a GitTimeoutError. */
  timeoutMs?: number;
  /** Added to git's environment. */
  env?: Record<string, string>;
}

/** Git, run with a timeout, didn't finish in time and was killed. */
export class GitTimeoutError extends TenzoError {
  override name = "GitTimeoutError";
}

/**
 * For git that talks to a remote while nobody watches: a credential prompt fails at once instead
 * of waiting for an answer no one will type (git's own prompt, and Git Credential Manager's).
 */
export const NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };

/** Runs git in `cwd` and resolves with its exit code and output; rejects only if git can't run. */
export function runGit(
  cwd: string,
  args: readonly string[],
  options: RunGitOptions = {},
): Promise<GitResult> {
  const env = { ...process.env, ...options.env };
  for (const key of REDIRECTING_ENV) delete env[key];
  const { timeoutMs } = options;
  return new Promise((resolvePromise, reject) => {
    // Under a timeout git runs detached: in a process group of its own, with no terminal to
    // prompt on, so the timeout kills its helpers (git-remote-https, ssh) along with it. Without
    // that a helper keeps git's output open, and git never seems to end.
    const child = spawn("git", args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: timeoutMs !== undefined,
    });
    let stdout = "";
    let stderr = "";
    let failure: Error | null = null;
    const kill = (why: Error) => {
      failure ??= why;
      try {
        if (timeoutMs === undefined || child.pid === undefined) child.kill("SIGKILL");
        else process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL"); // the group has gone already
      }
    };
    const collect = (append: (chunk: string) => void) => (chunk: Buffer) => {
      append(chunk.toString("utf8"));
      if (stdout.length + stderr.length > MAX_OUTPUT) {
        kill(new TenzoError(`git ${args[0] ?? ""} wrote more than ${MAX_OUTPUT} characters`));
      }
    };
    child.stdout.on("data", collect((chunk) => (stdout += chunk)));
    child.stderr.on("data", collect((chunk) => (stderr += chunk)));
    const timer =
      timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            const seconds = Math.round(timeoutMs / 1000);
            kill(new GitTimeoutError(`git ${args[0] ?? ""} gave no answer in ${seconds}s`));
          }, timeoutMs);
    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      const missing = error.code === "ENOENT";
      if (missing && !existsSync(cwd)) reject(new TenzoError(`${cwd} does not exist`));
      else reject(missing ? new TenzoError("git is not installed or not on PATH") : error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (failure) reject(failure);
      else if (code === null) reject(new TenzoError(`git ${args[0] ?? ""} was killed (${signal})`));
      else resolvePromise({ code, stdout, stderr });
    });
  });
}

const MAX_OUTPUT = 16 * 1024 * 1024;

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
  // Git runs in the repo, so a relative path would land the worktree inside the user's checkout.
  if (!isAbsolute(path)) throw new Error(`Worktree path must be absolute, got "${path}"`);
  // --no-track: a thread's branch must not push to the default branch's upstream by accident.
  // `--`: nothing after it can be read as an option.
  await git(root, ["worktree", "add", "--no-track", "-b", branch, "--", path, base]);
}

/** How long `landedOn` waits for origin to answer. */
export const FETCH_TIMEOUT_MS = 30_000;

/**
 * Whether everything the worktree's HEAD changes is already in `origin/<branch>`, by git alone:
 * after fetching it, merging HEAD into it would change nothing (its merge with HEAD has the same
 * tree as it has). Unlike asking whether HEAD is an ancestor, this holds after a squash or
 * rebase merge too. A conflict (the branch has since changed the same lines) counts as not
 * landed. Throws a TenzoError when there is no origin to fetch from, or it gives no answer in
 * `fetchTimeoutMs` (a stuck remote, or one that wants a password: git never prompts here).
 */
export async function landedOn(
  path: string,
  branch: string,
  fetchTimeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<boolean> {
  const remote = `refs/remotes/origin/${branch}`;
  let fetched: GitResult;
  try {
    fetched = await runGit(path, ["fetch", "--quiet", "origin", `+refs/heads/${branch}:${remote}`], {
      timeoutMs: fetchTimeoutMs,
      env: NO_PROMPT_ENV,
    });
  } catch (error) {
    if (!(error instanceof GitTimeoutError)) throw error;
    const seconds = Math.round(fetchTimeoutMs / 1000);
    throw new TenzoError(
      `Couldn't fetch ${branch} from origin: no answer in ${seconds}s. Is origin reachable, and can git reach it without a password prompt?`,
    );
  }
  if (fetched.code !== 0) {
    throw new TenzoError(`Couldn't fetch ${branch} from origin: ${fetched.stderr.trim() || "no output"}`);
  }
  const merged = await runGit(path, ["merge-tree", "--write-tree", remote, "HEAD"]);
  if (merged.code !== 0) return false; // 1: conflicts; anything else: can't tell, so not landed
  const tree = merged.stdout.split("\n")[0]?.trim();
  return tree !== undefined && tree === (await git(path, ["rev-parse", `${remote}^{tree}`]));
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
  await git(root, ["worktree", "remove", ...(force ? ["--force"] : []), "--", path]);
}

export async function deleteBranch(root: string, branch: string): Promise<void> {
  await git(root, ["branch", "-D", branch]);
}
