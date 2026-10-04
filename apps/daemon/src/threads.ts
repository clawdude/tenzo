import { existsSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentKind, EnvironmentId, ThreadId } from "@tenzo/contracts";
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

/** A thread's record: its workspace and agent session. What it is doing lives in events (fold.ts). */
export interface Thread {
  id: ThreadId;
  environmentId: EnvironmentId;
  projectId: Project["id"];
  title: string;
  slug: string;
  /** `tenzo/<slug>`; outlives the thread so finished work is never lost. */
  branch: string;
  worktreePath: string;
  status: "active" | "archived";
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  /** The agent running this thread, once it has started. */
  agent: AgentKind | null;
  /** The agent's own session id: what resumes the conversation after a restart. */
  sessionId: string | null;
  /** The model the thread runs, when one was picked; else the agent's default. */
  model: string | null;
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
  options: {
    model?: string;
    /** The prompt `title` stands in for until the titler names the thread (`finishNaming`). */
    naming?: string;
    /** The client's key for this create (see `threadByClientKey`). */
    clientKey?: string;
  } = {},
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
    environmentId: store.environmentId,
    projectId: project.id,
    title: title.trim(),
    slug,
    branch: BRANCH_PREFIX + slug,
    worktreePath: worktreePath(store, project.name, id),
    status: "active",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    agent: null,
    sessionId: null,
    model: options.model ?? null,
  };

  await addWorktree(project.path, thread.worktreePath, thread.branch, base);
  try {
    store.db
      .prepare(
        `INSERT INTO threads
           (id, project_id, title, slug, branch, worktree_path, status, created_at, updated_at,
            environment_id, model, naming, client_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        thread.id,
        thread.projectId,
        thread.title,
        thread.slug,
        thread.branch,
        thread.worktreePath,
        thread.status,
        now,
        now,
        thread.environmentId,
        thread.model,
        options.naming ?? null,
        options.clientKey ?? null,
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
 *
 * If the project's repo has been moved or deleted there is no git left to ask: `force` then
 * deletes the worktree folder itself so the thread (and then the project) can be let go.
 */
export async function archiveThread(
  store: Store,
  threadId: string,
  options: { force?: boolean } = {},
): Promise<Thread> {
  const thread = getThread(store, threadId);
  if (thread.status === "archived") return thread;
  const project = projectOf(store, thread);
  const force = options.force ?? false;

  await checkArchivable(store, thread, { force });
  if (!existsSync(join(project.path, ".git"))) {
    deleteWorktreeFolder(store, project, thread);
  } else {
    await removeWorktree(project.path, thread.worktreePath, force);
  }

  const now = new Date().toISOString();
  store.db
    .prepare("UPDATE threads SET status = 'archived', archived_at = ?, updated_at = ? WHERE id = ?")
    .run(now, now, thread.id);
  return { ...thread, status: "archived", archivedAt: now, updatedAt: now };
}

/**
 * Throws the TenzoError `archiveThread` would refuse with (uncommitted work, a gone repo) without
 * touching anything, so a caller can ask before stopping the thread's agent.
 */
export async function checkArchivable(
  store: Store,
  thread: Thread,
  options: { force?: boolean } = {},
): Promise<void> {
  if (options.force || thread.status === "archived") return;
  const project = projectOf(store, thread);
  if (!existsSync(join(project.path, ".git"))) {
    throw new TenzoError(
      `The repo ${project.path} is gone (moved or deleted). Archive with --force to forget this thread and delete ${thread.worktreePath}.`,
    );
  }
  if (await worktreeHasChanges(thread.worktreePath)) {
    throw new TenzoError(
      `${thread.worktreePath} has uncommitted changes. Commit them to ${thread.branch}, or archive with --force to discard them.`,
    );
  }
}

/** Records the agent session a thread runs in, so a later run can resume it. */
export function setThreadSession(
  store: Store,
  threadId: ThreadId,
  agent: AgentKind,
  sessionId: string,
): void {
  store.db
    .prepare("UPDATE threads SET agent = ?, session_id = ?, updated_at = ? WHERE id = ?")
    .run(agent, sessionId, new Date().toISOString(), threadId);
}

/**
 * Ends a thread's naming: renames it to `title` when the titler found one (its slug and branch
 * keep the name it started with), or keeps the stand-in for good when it found none.
 */
export function finishNaming(store: Store, threadId: ThreadId, title: string | null): void {
  if (title === null) {
    store.db.prepare("UPDATE threads SET naming = NULL WHERE id = ?").run(threadId);
    return;
  }
  store.db
    .prepare("UPDATE threads SET title = ?, naming = NULL, updated_at = ? WHERE id = ?")
    .run(title, new Date().toISOString(), threadId);
}

/** Active threads still under a stand-in title, with the prompt to name each from. */
export function threadsToName(store: Store): { id: ThreadId; prompt: string }[] {
  return store.db
    .prepare(
      `SELECT id, naming FROM threads
       WHERE status = 'active' AND naming IS NOT NULL
       ORDER BY created_at, id`,
    )
    .all()
    .map((row) => ({ id: String(row.id) as ThreadId, prompt: String(row.naming) }));
}

/** The thread an earlier `thread.create` with this client key made, if any. */
export function threadByClientKey(store: Store, clientKey: string): Thread | undefined {
  const row = store.db.prepare("SELECT * FROM threads WHERE client_key = ?").get(clientKey);
  return row ? toThread(row) : undefined;
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

/** The thread's project, even one that has been removed since. */
export function projectOf(store: Store, thread: Thread): Project {
  const row = store.db.prepare("SELECT * FROM projects WHERE id = ?").get(thread.projectId);
  if (!row) throw new Error(`Thread ${thread.id} points at missing project ${thread.projectId}`);
  return toProject(row);
}

/**
 * `rm -rf` for a worktree whose repo is gone, but only ever the folder Tenzo itself made for this
 * thread, `<home>/worktrees/<project>/<thread id>`: a tampered path, a symlinked project folder or
 * a symlinked worktree is refused rather than followed.
 */
function deleteWorktreeFolder(store: Store, project: Project, thread: Thread): void {
  const path = thread.worktreePath;
  const refuse = (why: string) =>
    new TenzoError(`Refusing to delete ${path}: ${why}. Remove it by hand if it is safe to.`);
  const expected = worktreePath(store, project.name, thread.id);
  if (path !== expected) throw refuse(`Tenzo made this thread's worktree at ${expected}`);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return; // already gone
  if (!stat.isDirectory()) throw refuse("it is not a plain folder");
  const root = join(store.home, "worktrees");
  if (realpathSync(dirname(path)) !== join(realpathSync(root), project.name)) {
    throw refuse(`its folder does not resolve to ${join(root, project.name)}`);
  }
  rmSync(path, { recursive: true, force: true });
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
    environmentId: String(row.environment_id) as EnvironmentId,
    projectId: String(row.project_id) as Project["id"],
    title: String(row.title),
    slug: String(row.slug),
    branch: String(row.branch),
    worktreePath: String(row.worktree_path),
    status: row.status === "archived" ? "archived" : "active",
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    archivedAt: row.archived_at === null ? null : String(row.archived_at),
    agent: row.agent === "claude" || row.agent === "codex" ? row.agent : null,
    sessionId:
      row.session_id === null || row.session_id === undefined ? null : String(row.session_id),
    model: row.model === null || row.model === undefined ? null : String(row.model),
  };
}
