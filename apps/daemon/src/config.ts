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
  /**
   * Host names besides loopback that clients may use to reach the daemon, such as the Tailscale
   * Serve name. `TENZO_ALLOWED_HOSTS`, comma-separated. See access.ts.
   */
  allowedHosts: string[];
  /**
   * Origins of dev servers whose pages may call the API and open `/ws`, e.g. Vite's
   * `http://localhost:5173` (`pnpm dev` sets it). `TENZO_DEV_ORIGIN`, comma-separated.
   */
  devOrigins: string[];
}

/** Reads daemon settings from the environment, failing loudly on nonsense. */
export function readConfig(env: Record<string, string | undefined>): DaemonConfig {
  return {
    host: "127.0.0.1",
    port: readPort(env.TENZO_PORT),
    // Absolute, always: git runs with the repo as cwd, so a relative home would put worktrees
    // inside the user's repo.
    home: resolve(env.TENZO_HOME || join(homedir(), ".tenzo")),
    webDir: resolve(env.TENZO_WEB_DIR || DEFAULT_WEB_DIR),
    allowedHosts: readHosts(env.TENZO_ALLOWED_HOSTS),
    devOrigins: readOrigins(env.TENZO_DEV_ORIGIN),
  };
}

function readOrigins(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter((o) => o !== "")
    .map((o) => {
      let url: URL | undefined;
      try {
        url = new URL(o);
      } catch {
        // reported below
      }
      if (!url || (url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== o.replace(/\/$/, "")) {
        throw new Error(
          `TENZO_DEV_ORIGIN takes origins separated by commas, like http://localhost:5173, got "${o}"`,
        );
      }
      return url.origin;
    });
}

function readPort(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`TENZO_PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return port;
}

function readHosts(raw: string | undefined): string[] {
  const hosts = (raw ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter((h) => h !== "");
  for (const host of hosts) {
    if (!/^[a-z0-9.-]+$/.test(host)) {
      throw new Error(
        `TENZO_ALLOWED_HOSTS takes host names separated by commas (no scheme or port), got "${host}"`,
      );
    }
  }
  return hosts;
}
