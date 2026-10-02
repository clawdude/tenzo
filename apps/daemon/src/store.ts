import type { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import type { EnvironmentId } from "@tenzo/contracts";
import { openDatabase } from "./db.ts";
import { loadEnvironmentId } from "./environment.ts";
import { ensureHome } from "./home.ts";

/** Tenzo's state on this machine: the SQLite database and the worktrees, both under `home`. */
export interface Store {
  db: DatabaseSync;
  /** `$TENZO_HOME`. */
  home: string;
  /** This machine's identity, stamped on every record. */
  environmentId: EnvironmentId;
  close(): void;
}

export function openStore(homeDir: string): Store {
  // Absolute: worktree paths are built from it and handed to git running in the repo.
  const home = resolve(homeDir);
  ensureHome(home);
  const environmentId = loadEnvironmentId(home);
  const db = openDatabase(join(home, "tenzo.db"));
  // Rows from before records carried the environment id belong to this machine.
  for (const table of ["projects", "threads"]) {
    db.prepare(`UPDATE ${table} SET environment_id = ? WHERE environment_id IS NULL`).run(
      environmentId,
    );
  }
  return { db, home, environmentId, close: () => db.close() };
}

/** Runs `fn` in one write transaction: all of it lands, or none. */
export function transaction<T>(store: Store, fn: () => T): T {
  store.db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    store.db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      store.db.exec("ROLLBACK");
    } catch {
      // already rolled back by SQLite
    }
    throw error;
  }
}

/** Where thread worktrees live: `<home>/worktrees/<project name>/<thread id>`. */
export function worktreePath(store: Store, projectName: string, threadId: string): string {
  return join(store.home, "worktrees", projectName, threadId);
}
