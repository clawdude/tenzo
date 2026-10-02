import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_PORT = 4780;

/** Where `pnpm build` puts the web app, relative to this file. */
const DEFAULT_WEB_DIR = resolve(import.meta.dirname, "../../web/build");

export interface DaemonConfig {
  /** Loopback only; remote access goes through Tailscale Serve (PRODUCT.md, M4). */
  host: "127.0.0.1";
  port: number;
  /** Tenzo's own state: environment id, later SQLite and worktrees. `TENZO_HOME`, default `~/.tenzo`. */
  home: string;
  /** The built web app the daemon serves. `TENZO_WEB_DIR`, default `apps/web/build`. */
  webDir: string;
}

/** Reads daemon settings from the environment, failing loudly on nonsense. */
export function readConfig(env: Record<string, string | undefined>): DaemonConfig {
  return {
    host: "127.0.0.1",
    port: readPort(env.TENZO_PORT),
    home: env.TENZO_HOME || join(homedir(), ".tenzo"),
    webDir: env.TENZO_WEB_DIR || DEFAULT_WEB_DIR,
  };
}

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`TENZO_PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return port;
}
