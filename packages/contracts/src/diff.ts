import { z } from "zod";

/**
 * The change a thread made (`thread.diff`): what `git diff --numstat` says of the thread's
 * worktree against where its branch left the project's default branch, plus files it created and
 * hasn't committed yet. Counts only; the diff itself is the agent's (and git's) to show.
 */

export const DiffFileStatus = z.enum(["added", "modified", "deleted", "renamed", "untracked"]);
export type DiffFileStatus = z.infer<typeof DiffFileStatus>;

export const DiffFile = z.object({
  /** Relative to the worktree's top. */
  path: z.string(),
  /** A renamed file's old path. */
  from: z.string().optional(),
  status: DiffFileStatus,
  /** Lines added and deleted; null for a binary file (or an untracked file too big to count). */
  added: z.number().int().nonnegative().nullable(),
  deleted: z.number().int().nonnegative().nullable(),
});
export type DiffFile = z.infer<typeof DiffFile>;

export const ThreadDiff = z.object({
  /** The branch it is compared with: the project's default branch. */
  base: z.string(),
  /** Changed files, by path; at most `MAX_DIFF_FILES` of them. */
  files: z.array(DiffFile),
  /** How many files changed, including any left out of `files`. */
  fileCount: z.number().int().nonnegative(),
  /** Lines added and deleted over every counted file, left-out ones included. */
  added: z.number().int().nonnegative(),
  deleted: z.number().int().nonnegative(),
  /** More files changed than `files` lists. */
  truncated: z.boolean(),
});
export type ThreadDiff = z.infer<typeof ThreadDiff>;

/** The most files `thread.diff` lists. */
export const MAX_DIFF_FILES = 300;
