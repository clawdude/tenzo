import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TenzoError } from "./errors.ts";

/** Creates `$TENZO_HOME` if needed, private to this user: it holds Tenzo's database and worktrees. */
export function ensureHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
}

/**
 * Claims `home` for this daemon: one daemon per home runs its threads. A lock left by a daemon
 * that died is taken over. Returns the release function.
 */
export function lockHome(home: string): () => void {
  ensureHome(home);
  const pid = process.pid;
  const path = join(home, "daemon.pid");
  const taken = () =>
    new TenzoError(
      `Another tenzo daemon (pid ${readPid(path) ?? "?"}) is running on ${home}. Stop it first, or use another TENZO_HOME.`,
    );
  if (held.has(path)) throw taken();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${pid}\n`, { flag: "wx" });
      held.add(path);
      return () => {
        held.delete(path);
        if (readPid(path) === pid) rmSync(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = readPid(path);
      if (holder !== null && holder !== pid && isRunning(holder)) throw taken();
      rmSync(path, { force: true }); // left behind by a daemon that died
    }
  }
  throw new TenzoError(`Couldn't lock ${home}; another daemon is starting.`);
}

/** Locks held by this process (tests run several daemons in one). */
const held = new Set<string>();

function readPid(path: string): number | null {
  try {
    const pid = Number(readFileSync(path, "utf8").trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
