import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const DEFAULT_PORT = 4780;

/** Where `pnpm build` puts the web app, relative to this file. */
const DEFAULT_WEB_DIR = resolve(import.meta.dirname, "../../web/build");

export interface DaemonConfig {
  /** Loopback only; remote access goes through Tailscale Serve (PRODUCT.md, M4). */
  host: "127.0.0.1";
  port: number;
  /**
   * The second listener, for threads' live apps (live.ts): an origin of their own, so a page an
   * agent serves can't call Tenzo's API. `TENZO_LIVE_PORT`, default `port + 1` (0 with port 0).
   */
  livePort?: number;
  /**
   * Where the live listener is reached from elsewhere, e.g. a second Tailscale Serve route
   * `https://my-mac.tailnet.ts.net:8444`. `TENZO_LIVE_ORIGIN`, comma-separated. Open live links
   * to the one whose host name the browser reached Tenzo by; else to the live port on that name.
   */
  liveOrigins?: string[];
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
   * Where devices elsewhere reach Tenzo, e.g. the Tailscale Serve route
   * `https://my-mac.tailnet.ts.net:8443`, port included: the daemon gives it to `tenzo pair` for
   * its links. `TENZO_PUBLIC_URL`; unset, `tenzo pair` needs `--url` (no guessing a port).
   */
  publicUrl?: string;
  /**
   * Origins of dev servers whose pages may call the API and open `/ws`, e.g. Vite's
   * `http://localhost:5173` (`pnpm dev` sets it). `TENZO_DEV_ORIGIN`, comma-separated.
   */
  devOrigins: string[];
  /**
   * The model threads run when they are started without one, e.g. "haiku" for cheap trial runs.
   * `TENZO_DEFAULT_MODEL`; unset, the agent's own default (the user's config).
   */
  defaultModel?: string;
  /**
   * How long a swipe snoozes an item, in ms. `TENZO_SNOOZE_MS`, for trying snooze without
   * waiting; unset, 15 minutes (engine.ts).
   */
  snoozeMs?: number;
}

/** Reads daemon settings from the environment, failing loudly on nonsense. */
export function readConfig(env: Record<string, string | undefined>): DaemonConfig {
  const port = readPort(env.TENZO_PORT);
  const livePort = env.TENZO_LIVE_PORT ? readPort(env.TENZO_LIVE_PORT, "TENZO_LIVE_PORT") : port + 1;
  if (livePort === port || livePort > 65_535) {
    throw new Error(
      `TENZO_LIVE_PORT must be a free port other than TENZO_PORT (${port}), got ${livePort}`,
    );
  }
  return {
    host: "127.0.0.1",
    port,
    livePort,
    liveOrigins: readOrigins(env.TENZO_LIVE_ORIGIN, "TENZO_LIVE_ORIGIN", "https://my-mac.tailnet.ts.net:8444"),
    // Absolute, always: git runs with the repo as cwd, so a relative home would put worktrees
    // inside the user's repo.
    home: resolve(env.TENZO_HOME || join(homedir(), ".tenzo")),
    webDir: resolve(env.TENZO_WEB_DIR || DEFAULT_WEB_DIR),
    allowedHosts: readHosts(env.TENZO_ALLOWED_HOSTS),
    devOrigins: readOrigins(env.TENZO_DEV_ORIGIN, "TENZO_DEV_ORIGIN", "http://localhost:5173"),
    ...publicUrl(env.TENZO_PUBLIC_URL),
    ...(env.TENZO_DEFAULT_MODEL?.trim() ? { defaultModel: env.TENZO_DEFAULT_MODEL.trim() } : {}),
    ...(env.TENZO_SNOOZE_MS?.trim() ? { snoozeMs: readSnooze(env.TENZO_SNOOZE_MS.trim()) } : {}),
  };
}

function publicUrl(raw: string | undefined): { publicUrl?: string } {
  const [origin, ...more] = readOrigins(raw, "TENZO_PUBLIC_URL", "https://my-mac.tailnet.ts.net:8443");
  if (more.length > 0) {
    throw new Error(`TENZO_PUBLIC_URL takes one origin, like https://my-mac.tailnet.ts.net:8443, got "${raw}"`);
  }
  return origin ? { publicUrl: origin } : {};
}

function readSnooze(raw: string): number {
  const ms = Number(raw);
  if (!Number.isInteger(ms) || ms < 1_000 || ms > 24 * 60 * 60_000) {
    throw new Error(`TENZO_SNOOZE_MS must be a whole number of ms from 1000 to 86400000, got "${raw}"`);
  }
  return ms;
}

function readOrigins(raw: string | undefined, name: string, example: string): string[] {
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
          `${name} takes origins separated by commas, like ${example}, got "${o}"`,
        );
      }
      return url.origin;
    });
}

function readPort(raw: string | undefined, name = "TENZO_PORT"): number {
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer between 1 and 65535, got "${raw}"`);
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
