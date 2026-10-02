import { existsSync } from "node:fs";
import type { ThreadId } from "@tenzo/contracts";
import { TenzoError } from "./errors.ts";
import {
  addWorktree,
  branchExists,
  deleteBranch,
  hasChanges,
  removeWorktree,
  resolveBase,
} from "./git.ts";
import { randomId } from "./ids.ts";
import { findProject, type Project, toProject } from "./projects.ts";
import { firstFree, slugify } from "./slug.ts";
import { type Store, worktreePath } from "./store.ts";

/** Threads proper (agent, lifecycle, items) arrive with the event store (#6); this is the git side. */
export interface Thread {
  id: ThreadId;
  projectId: Project["id"];
  slug: string;
  /** `tenzo/<slug>`; outlives the thread so finished work is never lost. */
  branch: string;
  worktreePath: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

const BRANCH_PREFIX = "tenzo/";

/**
 * Starts a thread's workspace: a new worktree at `<home>/worktrees/<project>/<thread id>` on a new
 * branch `tenzo/<slug>` cut from the project's default branch. The main checkout is untouched.
 * The slug comes from `title`; if the project already has it (as a thread or a branch), `-2`, `-3`, …
 */
export async function createThread(
  store: Store,
  projectRef: string,
  title: string,
): Promise<Thread> {
  const project = findProject(store, projectRef);
  const base = await resolveBase(project.path, project.defaultBranch);
  const slug = await firstFree(
    slugify(title, "thread"),
    async (candidate) =>
      Boolean(
        store.db
          .prepare("SELECT 1 FROM threads WHERE project_id = ? AND slug = ?")
          .get(project.id, candidate),
      ) || (await branchExists(project.path, BRANCH_PREFIX + candidate)),
  );

  const id: ThreadId = randomId("thr");
  const now = new Date().toISOString();
  const thread: Thread = {
    id,
    projectId: project.id,
    slug,
    branch: BRANCH_PREFIX + slug,
    worktreePath: worktreePath(store, project.name, id),
    status: "active",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  };

  await addWorktree(project.path, thread.worktreePath, thread.branch, base);
  try {
    store.db
      .prepare(
        `INSERT INTO threads (id, project_id, slug, branch, worktree_path, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        thread.projectId,
        thread.slug,
        thread.branch,
        thread.worktreePath,
        thread.status,
        now,
        now,
      );
  } catch (error) {
    // Nobody has seen this worktree or branch yet: undo both rather than leave strays.
    await removeWorktree(project.path, thread.worktreePath, true).catch(() => {});
    await deleteBranch(project.path, thread.branch).catch(() => {});
    throw error;
  }
  return thread;
}

/**
 * Archives a thread: removes its worktree, keeps its branch. Refuses when the worktree holds
 * uncommitted changes unless `force`, because removing it would throw that work away.
 */
export async function archiveThread(
  store: Store,
  threadId: string,
  options: { force?: boolean } = {},
): Promise<Thread> {
  const thread = getThread(store, threadId);
  if (thread.status === "archived") return thread;
  const project = projectOf(store, thread);

  if (!options.force && (await worktreeHasChanges(thread.worktreePath))) {
    throw new TenzoError(
      `${thread.worktreePath} has uncommitted changes. Commit them to ${thread.branch}, or archive with --force to discard them.`,
    );
  }
  await removeWorktree(project.path, thread.worktreePath, options.force ?? false);

  const now = new Date().toISOString();
  store.db
    .prepare("UPDATE threads SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, thread.id);
  return { ...thread, status: "archived", archivedAt: now, updatedAt: now };
}

export function getThread(store: Store, threadId: string): Thread {
  const row = store.db.prepare("SELECT * FROM threads WHERE id = ?").get(threadId);
  if (!row) throw new TenzoError(`No thread "${threadId}". \`tenzo thread list\` shows them.`);
  return toThread(row);
}

export function listThreads(
  store: Store,
  filter: { projectId?: Project["id"]; includeArchived?: boolean } = {},
): Thread[] {
  const rows = store.db
    .prepare(
      `SELECT * FROM threads
       WHERE (:project IS NULL OR project_id = :project) AND (:all = 1 OR status = 'active')
       ORDER BY created_at, id`,
    )
    .all({ project: filter.projectId ?? null, all: filter.includeArchived ? 1 : 0 });
  return rows.map(toThread);
}

function projectOf(store: Store, thread: Thread): Project {
  const row = store.db.prepare("SELECT * FROM projects WHERE id = ?").get(thread.projectId);
  if (!row) throw new Error(`Thread ${thread.id} points at missing project ${thread.projectId}`);
  return toProject(row);
}

async function worktreeHasChanges(path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  try {
    return await hasChanges(path);
  } catch {
    return false; // gone or no longer a worktree: nothing left to lose
  }
}

function toThread(row: Record<string, unknown>): Thread {
  return {
    id: String(row.id) as ThreadId,
    projectId: String(row.project_id) as Project["id"],
    slug: String(row.slug),
    branch: String(row.branch),
    worktreePath: String(row.worktree_path),
    status: row.status === "archived" ? "archived" : "active",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archivedAt: row.archived_at === null ? null : String(row.archived_at),
  };
}
