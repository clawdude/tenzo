import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { type DiffFile, type DiffFileStatus, MAX_DIFF_FILES, type ThreadDiff } from "@tenzo/contracts";
import { GitError, runGit } from "./git.ts";

/**
 * What a thread changed, as counts: `git diff --numstat` against the point where its branch left
 * the project's default branch (so later commits on the default branch don't count), computed on
 * demand and never stored. In a worktree it compares the files as they are, uncommitted edits
 * included, and adds untracked files as new; for a commit (`head`, an archived thread's branch)
 * it compares that commit.
 */
export interface DiffOptions {
  /** A commit to compare instead of the working tree. */
  head?: string;
  /** The branch name to report as the base (default: `base` as given). */
  baseName?: string;
  maxFiles?: number;
}

/** Untracked files bigger than this aren't counted (their lines show as unknown). */
export const MAX_COUNTED_BYTES = 1024 * 1024;
/** How much of the untracked files one diff reads, in all, to count their lines. */
export const MAX_COUNTED_TOTAL = 8 * 1024 * 1024;

export async function diffStat(
  cwd: string,
  base: string,
  { head, baseName = base, maxFiles = MAX_DIFF_FILES }: DiffOptions = {},
): Promise<ThreadDiff> {
  const from = await mergeBase(cwd, base, head ?? "HEAD");
  const range = head ? [from, head] : [from];
  // No external diff tools, no textconv: plain counts from git itself.
  const common = ["diff", "--no-ext-diff", "--no-textconv", "-M", "-z"];
  const [numstat, names] = await Promise.all([
    rawGit(cwd, [...common, "--numstat", ...range, "--"]),
    rawGit(cwd, [...common, "--name-status", ...range, "--"]),
  ]);
  const statuses = parseNameStatus(names);
  const files: DiffFile[] = parseNumstat(numstat).map((f) => ({
    ...f,
    status: statuses.get(f.path) ?? (f.from ? "renamed" : "modified"),
  }));

  if (!head) {
    const untracked = splitZ(await rawGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]));
    // Lines are counted only for as many as can be listed, and only so many bytes in all: the
    // rest are in the file count with their lines unknown.
    const room = Math.max(0, maxFiles - files.length);
    let budget = MAX_COUNTED_TOTAL;
    for (const [index, path] of untracked.entries()) {
      const counted = index < room && budget > 0 ? await countLines(join(cwd, path)) : null;
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
    truncated: files.length > maxFiles,
  };
}

/** Where `head` left `base`; `base` itself when they share no history. */
async function mergeBase(cwd: string, base: string, head: string): Promise<string> {
  const result = await runGit(cwd, ["merge-base", base, head]);
  const found = result.stdout.trim();
  return result.code === 0 && found !== "" ? found : base;
}

/** The command's output as it is (`git()` trims it, and a path may end in a space). */
async function rawGit(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runGit(cwd, args);
  if (result.code !== 0) throw new GitError(args, result.code, result.stderr);
  return result.stdout;
}

function splitZ(output: string): string[] {
  return output.split("\0").filter((s) => s !== "");
}

/**
 * `diff --numstat -z`: `added\tdeleted\tpath\0`, or for a rename `added\tdeleted\t\0old\0new\0`.
 * A binary file's counts are `-`.
 */
export function parseNumstat(output: string): Omit<DiffFile, "status">[] {
  const parts = output.split("\0");
  const files: Omit<DiffFile, "status">[] = [];
  const count = (n: string) => (/^\d+$/.test(n) ? Number(n) : null);
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i] ?? "";
    if (record === "") continue;
    // Only the first two tabs separate: a path may hold tabs of its own.
    const [, added = "-", deleted = "-", path = ""] = /^([^\t]*)\t([^\t]*)\t([\s\S]*)$/.exec(record) ?? [];
    if (path === "") {
      const from = parts[++i] ?? "";
      const to = parts[++i] ?? "";
      files.push({ path: to, from, added: count(added), deleted: count(deleted) });
    } else {
      files.push({ path, added: count(added), deleted: count(deleted) });
    }
  }
  return files;
}

/** `diff --name-status -z`: `M\0path\0`, or for a rename or copy `R100\0old\0new\0`. */
export function parseNameStatus(output: string): Map<string, DiffFileStatus> {
  const parts = output.split("\0");
  const statuses = new Map<string, DiffFileStatus>();
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i] ?? "";
    if (code === "") continue;
    const letter = code.charAt(0);
    if (letter === "R" || letter === "C") {
      i++; // the old path
      statuses.set(parts[++i] ?? "", letter === "R" ? "renamed" : "added");
    } else {
      const path = parts[++i] ?? "";
      statuses.set(path, letter === "A" ? "added" : letter === "D" ? "deleted" : "modified");
    }
  }
  return statuses;
}

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
