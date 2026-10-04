import { spawn } from "node:child_process";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { type DiffFile, type DiffFileStatus, MAX_DIFF_FILES, type ThreadDiff } from "@tenzo/contracts";
import { GitError, REDIRECTING_ENV, runGit } from "./git.ts";

/**
 * What a thread changed, as counts: one `git diff --raw --numstat` against the point where its
 * branch left the project's default branch (so later commits on the default branch don't
 * count), computed on demand and never stored. In a worktree it compares the files as they are,
 * uncommitted edits included, and adds untracked files as new; for a commit (`head`, an archived
 * thread's branch) it compares that commit.
 */
export interface DiffOptions {
  /** A commit to compare instead of the working tree. */
  head?: string;
  /** The branch name to report as the base (default: `base` as given). */
  baseName?: string;
  maxFiles?: number;
  /** The most untracked files looked at (default `MAX_UNTRACKED`). */
  maxUntracked?: number;
}

/** Untracked files bigger than this aren't counted (their lines show as unknown). */
export const MAX_COUNTED_BYTES = 1024 * 1024;
/** How much of the untracked files one diff reads, in all, to count their lines. */
export const MAX_COUNTED_TOTAL = 8 * 1024 * 1024;
/**
 * The most untracked files one diff lists. A big tree nobody ignored (a `node_modules`) stops
 * here: the listing is cut short, and the diff says it is incomplete.
 */
export const MAX_UNTRACKED = 2000;

export async function diffStat(
  cwd: string,
  base: string,
  { head, baseName = base, maxFiles = MAX_DIFF_FILES, maxUntracked = MAX_UNTRACKED }: DiffOptions = {},
): Promise<ThreadDiff> {
  const from = await mergeBase(cwd, base, head ?? "HEAD");
  const range = head ? [from, head] : [from];
  // No external diff tools, no textconv: plain counts from git itself, in one pass.
  const output = await rawGit(cwd, [
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "-M",
    "-z",
    "--raw",
    "--numstat",
    ...range,
    "--",
  ]);
  const files = parseRawNumstat(output);
  let incomplete = false;

  if (!head) {
    const tracked = new Set(files.map((f) => f.path));
    const untracked = await listUntracked(cwd, maxUntracked);
    incomplete = untracked.more;
    // Lines are counted only for as many as can be listed, and only so many bytes in all: the
    // rest are in the file count with their lines unknown.
    const room = Math.max(0, maxFiles - files.length);
    let budget = MAX_COUNTED_TOTAL;
    let index = 0;
    for (const path of untracked.paths) {
      // Out of the index but still on disk (`git rm --cached`): it is in the diff already.
      if (tracked.has(path)) continue;
      const counted = index++ < room && budget > 0 ? await countLines(join(cwd, path)) : null;
      budget -= counted?.bytes ?? 0;
      const added = counted?.lines ?? null;
      files.push({ path, status: "untracked", added, deleted: added === null ? null : 0 });
    }
  }

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    base: baseName,
    files: files.slice(0, maxFiles),
    fileCount: files.length,
    added: files.reduce((sum, f) => sum + (f.added ?? 0), 0),
    deleted: files.reduce((sum, f) => sum + (f.deleted ?? 0), 0),
    truncated: files.length > maxFiles || incomplete,
    merged: head !== undefined && files.length === 0 && (await isAncestor(cwd, head, base)),
  };
}

/** Where `head` left `base`; `base` itself when they share no history. */
async function mergeBase(cwd: string, base: string, head: string): Promise<string> {
  const result = await runGit(cwd, ["merge-base", base, head]);
  const found = result.stdout.trim();
  return result.code === 0 && found !== "" ? found : base;
}

async function isAncestor(cwd: string, commit: string, of: string): Promise<boolean> {
  return (await runGit(cwd, ["merge-base", "--is-ancestor", commit, of])).code === 0;
}

/** The command's output as it is (`git()` trims it, and a path may end in a space). */
async function rawGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) throw new GitError(args, result.code, result.stderr);
  return result.stdout;
}

/**
 * Untracked files, at most `max` of them: the listing is read as it comes and stopped there, so
 * a huge tree can't fill memory. `more`: there were more.
 */
export function listUntracked(cwd: string, max: number): Promise<{ paths: string[]; more: boolean }> {
  const env = { ...process.env };
  for (const key of REDIRECTING_ENV) delete env[key];
  const args = ["ls-files", "--others", "--exclude-standard", "-z"];
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const paths: string[] = [];
    let rest = "";
    let more = false;
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (more) return;
      const parts = (rest + chunk).split("\0");
      rest = parts.pop() ?? "";
      for (const part of parts) {
        if (part === "") continue;
        if (paths.length === max) {
          more = true;
          child.kill();
          return;
        }
        paths.push(part);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 4096) stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (more) resolve({ paths, more });
      else if (code !== 0) reject(new GitError(args, code, stderr));
      else resolve({ paths, more: false });
    });
  });
}

/**
 * `diff --raw --numstat -z`: first a raw record per file, `:<modes> <shas> <status>\0path\0` (a
 * rename or copy has two paths), then a numstat record per file, `added\tdeleted\tpath\0` (for a
 * rename `added\tdeleted\t\0old\0new\0`; a binary file's counts are `-`). Paths are taken by
 * position, never parsed, so any byte in a path is fine.
 */
export function parseRawNumstat(output: string): DiffFile[] {
  const parts = output.split("\0");
  const statuses = new Map<string, DiffFileStatus>();
  const files: DiffFile[] = [];
  const count = (n: string) => (/^\d+$/.test(n) ? Number(n) : null);
  for (let i = 0; i < parts.length; i++) {
    const record = (parts[i] ?? "").replace(/^\n+/, "");
    if (record === "") continue;
    if (record.startsWith(":")) {
      const letter = record.split(" ").at(-1)?.charAt(0) ?? "M";
      if (letter === "R" || letter === "C") i++; // the old path
      const path = parts[++i] ?? "";
      statuses.set(path, STATUSES[letter] ?? "modified");
      continue;
    }
    // Only the first two tabs separate: a path may hold tabs of its own.
    const [, added = "-", deleted = "-", path = ""] =
      /^([^\t]*)\t([^\t]*)\t([\s\S]*)$/.exec(parts[i] ?? "") ?? [];
    const counts = { added: count(added), deleted: count(deleted) };
    if (path === "") {
      const from = parts[++i] ?? "";
      const to = parts[++i] ?? "";
      files.push({ path: to, from, status: statuses.get(to) ?? "renamed", ...counts });
    } else {
      files.push({ path, status: statuses.get(path) ?? "modified", ...counts });
    }
  }
  return files;
}

const STATUSES: Record<string, DiffFileStatus> = {
  A: "added",
  C: "added",
  D: "deleted",
  R: "renamed",
};

/**
 * A text file's line count and size; null for a binary file, one too big to read, one that isn't
 * a plain file, or one that's gone.
 */
export async function countLines(path: string): Promise<{ lines: number; bytes: number } | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Not through a symlink, and never a FIFO (opening one would wait for a writer).
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > MAX_COUNTED_BYTES) return null;
    handle = await open(path, "r");
    const bytes = await handle.readFile();
    if (bytes.subarray(0, 8000).includes(0)) return null; // git's own test for binary
    let lines = 0;
    for (const byte of bytes) if (byte === 10) lines++;
    if (bytes.length > 0 && bytes[bytes.length - 1] !== 10) lines++;
    return { lines, bytes: bytes.length };
  } catch {
    return null;
  } finally {
    await handle?.close();
  }
}
