import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test-only helpers: throwaway directories and real git repos in them. Git runs with no global
 * or system config, so the developer's hooks, templates and init.defaultBranch can't leak in.
 */
const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "tenzo-test-")));
const emptyConfig = join(sandbox, "empty.gitconfig");
writeFileSync(emptyConfig, "");
process.env.GIT_CONFIG_GLOBAL = emptyConfig;
process.env.GIT_CONFIG_NOSYSTEM = "1";
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"])
  delete process.env[key];

const IDENTITY = {
  GIT_AUTHOR_NAME: "Tenzo Test",
  GIT_AUTHOR_EMAIL: "test@tenzo.invalid",
  GIT_COMMITTER_NAME: "Tenzo Test",
  GIT_COMMITTER_EMAIL: "test@tenzo.invalid",
};

/** A fresh empty directory, symlinks resolved (macOS tmp lives behind /var → /private/var). */
export function tempDir(name = "dir"): string {
  return mkdtempSync(join(sandbox, `${name}-`));
}

export function removeTempDirs(): void {
  rmSync(sandbox, { recursive: true, force: true });
}

/** Runs git synchronously for test setup and assertions. */
export function sh(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: { ...process.env, ...IDENTITY },
    encoding: "utf8",
  }).trim();
}

/** A new repo with one commit on `branch`, at `<tempDir>/<name>`. */
export function initRepo(name = "app", branch = "main"): string {
  const dir = join(tempDir("repos"), name);
  mkdirSync(dir);
  sh(dir, "init", "--quiet", "--initial-branch", branch);
  writeFileSync(join(dir, "README.md"), "# app\n");
  sh(dir, "add", ".");
  sh(dir, "commit", "--quiet", "-m", "initial");
  return dir;
}

export function commitFile(
  dir: string,
  file: string,
  content: string,
  message = `add ${file}`,
): string {
  writeFileSync(join(dir, file), content);
  sh(dir, "add", file);
  sh(dir, "commit", "--quiet", "-m", message);
  return sh(dir, "rev-parse", "HEAD");
}
