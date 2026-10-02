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
        title          TEXT NOT NULL,         -- what the person called it
        slug           TEXT NOT NULL,         -- derived from the title; unique per project
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
    db.exec("PRAGMA journal_mode = WAL");
    // Migrations run with foreign keys off: SQLite's table-rebuild recipe drops the old table,
    // and with them on that drop would cascade-delete every child row. `migrate` checks the
    // keys itself before committing. The pragma is ignored inside a transaction, so set it here.
    db.exec("PRAGMA foreign_keys = OFF");
    migrate(db, migrations);
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.close();
    throw error;
  }
  return db;
}

/**
 * Applies the migrations this database hasn't seen yet, all or nothing. A database that is
 * already current is left alone: no write lock, no write. Run it with foreign keys off.
 */
export function migrate(db: DatabaseSync, migrations: readonly Migration[]): void {
  if (checkVersion(db, migrations) === migrations.length) return;

  // IMMEDIATE takes the write lock up front, so two processes can't both apply the same step.
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = checkVersion(db, migrations); // another process may have migrated meanwhile
    for (const migration of migrations.slice(current)) db.exec(migration.sql);
    const broken = db.prepare("PRAGMA foreign_key_check").all();
    if (broken.length > 0) {
      throw new Error(
        `Migration left ${broken.length} broken foreign key(s): ${JSON.stringify(broken)}`,
      );
    }
    db.exec(`PRAGMA user_version = ${migrations.length}`);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // SQLite already rolled back on its own (e.g. SQLITE_FULL); the original error is the story.
    }
    throw error;
  }
}

function checkVersion(db: DatabaseSync, migrations: readonly Migration[]): number {
  const current = schemaVersion(db);
  if (current > migrations.length) {
    throw new Error(
      `Tenzo's database is at schema ${current}, newer than this tenzo knows (${migrations.length}). Update tenzo.`,
    );
  }
  return current;
}

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get();
  return Number(row?.user_version ?? 0);
}
