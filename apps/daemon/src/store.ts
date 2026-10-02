import type { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { openDatabase } from "./db.ts";
import { ensureHome } from "./home.ts";

/** Tenzo's state on this machine: the SQLite database and the worktrees, both under `home`. */
export interface Store {
  db: DatabaseSync;
  /** `$TENZO_HOME`. */
  home: string;
  close(): void;
}

export function openStore(home: string): Store {
  ensureHome(home);
  const db = openDatabase(join(home, "tenzo.db"));
  return { db, home, close: () => db.close() };
}

/** Where thread worktrees live: `<home>/worktrees/<project name>/<thread id>`. */
export function worktreePath(store: Store, projectName: string, threadId: string): string {
  return join(store.home, "worktrees", projectName, threadId);
}
