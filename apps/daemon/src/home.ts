import { mkdirSync } from "node:fs";

/** Creates `$TENZO_HOME` if needed, private to this user: it holds Tenzo's database and worktrees. */
export function ensureHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
}
