import { randomBytes } from "node:crypto";
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TenzoError } from "./errors.ts";

/** Creates `$TENZO_HOME` if needed, private to this user: it holds Tenzo's database and worktrees. */
export function ensureHome(home: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
}

/**
 * Claims `home` for this daemon: one daemon per home runs its threads. Returns the release
 * function.
 *
 * The lock is `daemon.pid`, created whole and atomically (written aside, then hard-linked into
 * place, which fails if it exists). A lock whose pid is no longer running was left by a daemon
 * that died: it is moved aside atomically and taken over, unless what was moved turns out to be
 * a newer daemon's lock (two daemons racing over the same stale one), which is put back.
 */
export function lockHome(home: string): () => void {
  ensureHome(home);
  const pid = process.pid;
  const path = join(home, "daemon.pid");
  const taken = (holder: number | null) =>
    new TenzoError(
      `Another tenzo daemon (pid ${holder ?? "?"}) is running on ${home}. Stop it first, or use another TENZO_HOME. If no tenzo daemon is running (its pid now belongs to something else), delete ${path}.`,
    );
  if (held.has(path)) throw taken(pid);
  const release = () => {
    held.delete(path);
    if (readPid(path) === pid) rmSync(path, { force: true });
  };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (create(path, pid)) {
      held.add(path);
      return release;
    }
    const holder = readPid(path);
    if (holder === undefined) continue; // gone meanwhile: try again
    // Our own pid without our lock: an earlier process that had our pid. Stale too.
    if (holder !== null && holder !== pid && isRunning(holder)) throw taken(holder);
    // Stale (or unreadable): move exactly that file aside, then check it was the stale one.
    const aside = `${path}.stale-${pid}-${randomBytes(4).toString("hex")}`;
    try {
      renameSync(path, aside);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const moved = readPid(aside);
    if (moved !== holder) {
      // We moved a lock another daemon took a moment ago: put it back and let it run.
      try {
        linkSync(aside, path);
      } catch {
        // someone else holds the path now; theirs stands
      }
      rmSync(aside, { force: true });
      throw new TenzoError(`Another tenzo daemon is starting on ${home}.`);
    }
    rmSync(aside, { force: true });
  }
  throw new TenzoError(`Couldn't lock ${home}; another daemon is starting.`);
}

/** Creates the lock with our pid in one step; false if it exists. */
function create(path: string, pid: number): boolean {
  const temp = `${path}.${pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(temp, `${pid}\n`);
  try {
    linkSync(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

/** Locks held by this process (tests run several daemons in one). */
const held = new Set<string>();

/** The pid in a lock file; null when it holds no pid, undefined when there is no file. */
function readPid(path: string): number | null | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const pid = Number(text.trim());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
