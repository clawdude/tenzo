import { DatabaseSync } from "node:sqlite";

/**
 * One schema step. Migrations run in array order, each exactly once; the database remembers how
 * many have run in `PRAGMA user_version`. Never edit or reorder a shipped migration: append one.
 */
export interface Migration {
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    name: "projects and threads",
    sql: `
      CREATE TABLE projects (
        id             TEXT PRIMARY KEY,
        name           TEXT NOT NULL UNIQUE,  -- worktrees live under worktrees/<name>
        path           TEXT NOT NULL UNIQUE,  -- the repo's top level, symlinks resolved
        default_branch TEXT NOT NULL,         -- detected on add; threads branch from it
        created_at     TEXT NOT NULL
      ) STRICT;

      -- Minimal on purpose: the event store (#6) adds lifecycle, session and items.
      CREATE TABLE threads (
        id             TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        slug           TEXT NOT NULL,
        branch         TEXT NOT NULL,         -- tenzo/<slug>; kept after archive
        worktree_path  TEXT NOT NULL,
        status         TEXT NOT NULL,         -- 'active' | 'archived'
        created_at     TEXT NOT NULL,
        updated_at     TEXT NOT NULL,
        archived_at    TEXT,
        UNIQUE (project_id, slug)
      ) STRICT;

      CREATE INDEX threads_by_project ON threads (project_id, status);
    `,
  },
];

/** Opens (creating if needed) Tenzo's SQLite database and brings its schema up to date. */
export function openDatabase(
  path: string,
  migrations: readonly Migration[] = MIGRATIONS,
): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    // The CLI and the daemon write from separate processes: wait for the lock instead of failing.
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA journal_mode = WAL");
    migrate(db, migrations);
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/** Applies the migrations this database hasn't seen yet, all or nothing. */
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): void {
  // IMMEDIATE takes the write lock up front, so two processes can't both apply the same step.
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = schemaVersion(db);
    if (current > migrations.length) {
      throw new Error(
        `Tenzo's database is at schema ${current}, newer than this tenzo knows (${migrations.length}). Update tenzo.`,
      );
    }
    for (const migration of migrations.slice(current)) db.exec(migration.sql);
    db.exec(`PRAGMA user_version = ${migrations.length}`);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.user_version ?? 0);
}
