import { existsSync, realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import type { ProjectId } from "@tenzo/contracts";
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
}

/**
 * Registers the git repo containing `path`. Reads the repo and writes only to Tenzo's database:
 * no `.tenzo/` folder, no config, nothing in the working tree.
 */
export async function addProject(store: Store, path: string): Promise<Project> {
  const root = await repoRoot(path);
  const existing = projectByPath(store, root);
  if (existing) throw new TenzoError(`${root} is already a project, "${existing.name}"`);

  const defaultBranch = await detectDefaultBranch(root);
  const name = await firstFree(slugify(basename(root), "project"), (candidate) =>
    Boolean(store.db.prepare("SELECT 1 FROM projects WHERE name = ?").get(candidate)),
  );
  const project: Project = {
    id: randomId("prj"),
    name,
    path: root,
    defaultBranch,
    createdAt: new Date().toISOString(),
  };
  store.db
    .prepare(
      "INSERT INTO projects (id, name, path, default_branch, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(project.id, project.name, project.path, project.defaultBranch, project.createdAt);
  return project;
}

export function listProjects(store: Store): Project[] {
  return store.db.prepare("SELECT * FROM projects ORDER BY name").all().map(toProject);
}

/** Finds a project by name, id, or a path inside its repo. */
export function findProject(store: Store, ref: string): Project {
  const row = store.db.prepare("SELECT * FROM projects WHERE name = ? OR id = ?").get(ref, ref);
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
 * Forgets a project. Refuses while it has active threads, whose worktrees would be orphaned;
 * archive them first. The repo itself and any `tenzo/*` branches are left as they are.
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
      `"${project.name}" has ${active.length} active thread(s): ${active.join(", ")}. Archive them first.`,
    );
  }
  store.db.prepare("DELETE FROM projects WHERE id = ?").run(project.id);
  return project;
}

function projectByPath(store: Store, path: string): Project | undefined {
  const row = store.db.prepare("SELECT * FROM projects WHERE path = ?").get(path);
  return row ? toProject(row) : undefined;
}

export function toProject(row: Record<string, unknown>): Project {
  return {
    id: String(row.id) as ProjectId,
    name: String(row.name),
    path: String(row.path),
    defaultBranch: String(row.default_branch),
    createdAt: String(row.created_at),
  };
}
