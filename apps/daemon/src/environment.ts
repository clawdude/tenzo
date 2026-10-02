import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EnvironmentId } from "@tenzo/contracts";
import { ensureHome } from "./home.ts";
import { randomId } from "./ids.ts";

export function generateEnvironmentId(): EnvironmentId {
  return EnvironmentId.parse(randomId("env"));
}

/**
 * Returns this machine's environment id from `<home>/environment-id`, creating it on first run.
 * The id must survive restarts: every record and every client is keyed by it.
 */
export function loadEnvironmentId(home: string): EnvironmentId {
  const path = join(home, "environment-id");
  const existing = readId(path);
  if (existing !== null) return existing;

  ensureHome(home);
  // Write a temp file, then hard-link it into place: the link is atomic and fails if another
  // daemon got there first, so nobody ever reads a half-written id or overwrites a winner.
  const temp = join(home, `.environment-id-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(temp, `${generateEnvironmentId()}\n`);
    linkSync(temp, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  } finally {
    rmSync(temp, { force: true });
  }
  const winner = readId(path);
  if (winner === null) throw new Error(`Could not create the environment id at ${path}`);
  return winner;
}

function readId(path: string): EnvironmentId | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = EnvironmentId.safeParse(raw);
  if (!parsed.success) {
    // Never silently replace an identity: clients and records point at it.
    throw new Error(`${path} holds "${raw}", which is not an environment id; fix or delete it`);
  }
  return parsed.data;
}
