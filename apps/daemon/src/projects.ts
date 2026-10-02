import { existsSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { EnvironmentId, ProjectId } from "@tenzo/contracts";
import { TenzoError } from "./errors.ts";
import { detectDefaultBranch, repoRoot } from "./git.ts";
import { randomId } from "./ids.ts";
import { firstFree, slugify } from "./slug.ts";
import type { Store } from "./store.ts";

export interface Project {
  id: ProjectId;
  /** Short and unique; names the project in the CLI and its folder under `worktrees/`. */
  name: string;
  /** The repo's top level. Tenzo never writes here; threads get their own worktrees. */
  path: string;
  defaultBranch: string;
  createdAt: string;
  environmentId: EnvironmentId;
}

/**
 * Registers the git repo containing `path`. Reads the repo and writes only to Tenzo's database:
 * no `.tenzo/` folder, no config, nothing in the working tree. A project removed earlier comes
 * back as it was, with its name and its threads' history.
 */
export async function addProject(store: Store, path: string): Promise<Project> {
  const root = await repoRoot(path);
  const existing = projectByPath(store, root);
  if (existing && existing.removedAt === null) {
    throw new TenzoError(`${root} is already a project, "${existing.project.name}"`);
  }
  const defaultBranch = await detectDefaultBranch(root);
  if (existing) {
    store.db
      .prepare("UPDATE projects SET removed_at = NULL, default_branch = ? WHERE id = ?")
      .run(defaultBranch, existing.project.id);
    return { ...existing.project, defaultBranch };
  }

  const name = await firstFree(slugify(basename(root), "project"), (candidate) =>
    Boolean(store.db.prepare("SELECT 1 FROM projects WHERE name = ?").get(candidate)),
  );
  const project: Project = {
    id: randomId("prj"),
    name,
    path: root,
    defaultBranch,
    createdAt: new Date().toISOString(),
    environmentId: store.environmentId,
  };
  store.db
    .prepare(
      `INSERT INTO projects (id, name, path, default_branch, created_at, environment_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      project.id,
      project.name,
      project.path,
      project.defaultBranch,
      project.createdAt,
      project.environmentId,
    );
  return project;
}

export function listProjects(store: Store): Project[] {
  return store.db
    .prepare("SELECT * FROM projects WHERE removed_at IS NULL ORDER BY name")
    .all()
    .map(toProject);
}

/** Finds a project by name, id, or a path inside its repo. */
export function findProject(store: Store, ref: string): Project {
  const row = store.db
    .prepare("SELECT * FROM projects WHERE (name = ? OR id = ?) AND removed_at IS NULL")
    .get(ref, ref);
  if (row) return toProject(row);
  const absolute = resolve(ref);
  if (existsSync(absolute)) {
    const real = realpathSync(absolute);
    const byPath = listProjects(store).find(
      (p) => real === p.path || real.startsWith(`${p.path}/`),
    );
    if (byPath) return byPath;
  }
  throw new TenzoError(`No project "${ref}". \`tenzo project list\` shows them.`);
}

/**
 * Forgets a project: it leaves the lists, while its archived threads with their events and items
 * stay as history (adding the repo again brings it back). Refuses while it has active threads,
 * whose worktrees would be orphaned; archive them first. The repo and its `tenzo/*` branches are
 * left as they are.
 */
export function removeProject(store: Store, ref: string): Project {
  const project = findProject(store, ref);
  const active = store.db
    .prepare(
      "SELECT id FROM threads WHERE project_id = ? AND status = 'active' ORDER BY created_at",
    )
    .all(project.id)
    .map((row) => String(row.id));
  if (active.length > 0) {
    throw new TenzoError(
      `"${project.name}" has ${active.length} active thread(s): ${active.join(", ")}. Archive them first (\`tenzo thread archive <id>\`).`,
    );
  }
  store.db
    .prepare("UPDATE projects SET removed_at = ? WHERE id = ?")
    .run(new Date().toISOString(), project.id);
  return project;
}

/** The project at `path`, removed or not. */
function projectByPath(
  store: Store,
  path: string,
): { project: Project; removedAt: string | null } | undefined {
  const row = store.db.prepare("SELECT * FROM projects WHERE path = ?").get(path);
  if (!row) return undefined;
  return {
    project: toProject(row),
    removedAt: row.removed_at === null ? null : String(row.removed_at),
  };
}

export function toProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id) as ProjectId,
    name: String(row.name),
    path: String(row.path),
    defaultBranch: String(row.default_branch),
    createdAt: String(row.created_at),
    environmentId: String(row.environment_id) as EnvironmentId,
  };
}
