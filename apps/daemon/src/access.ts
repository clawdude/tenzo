import type { MiddlewareHandler } from "hono";

/**
 * Who may talk to the daemon over HTTP and WebSocket. It listens on loopback, but a web page in
 * the person's own browser can still reach loopback: by DNS rebinding (an attacker's name that
 * resolves to 127.0.0.1, so the browser calls it same-origin) or by a cross-site request. Since
 * the API starts agents and answers for you, both are refused:
 *
 * - the `Host` must name this machine: 127.0.0.1, localhost, ::1, or a configured name such as
 *   the Tailscale Serve host (`TENZO_ALLOWED_HOSTS`);
 * - a request that carries an `Origin` (every browser request that matters does, WebSocket
 *   upgrades included) must come from one of those hosts. Requests without one are not from a
 *   web page: the CLI, curl.
 */
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const;

export interface AccessPolicy {
  /** Hostnames allowed besides loopback, e.g. `my-mac.tailnet.ts.net`. */
  allowedHosts: readonly string[];
}

/** True when a `Host` header names this machine. The port doesn't matter; the name does. */
export function hostAllowed(host: string | undefined, policy: AccessPolicy): boolean {
  if (!host) return false;
  const name = hostname(`http://${host}`);
  return name !== null && allowed(name, policy);
}

/** True when a request may come from `origin`: absent (not a browser), or one of our hosts. */
export function originAllowed(origin: string | undefined, policy: AccessPolicy): boolean {
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // "null" (sandboxed frames, file:) and garbage
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return allowed(normalize(url.hostname), policy);
}

/** Refuses requests with a foreign `Host` everywhere, and a foreign `Origin` where `guarded`. */
export function accessGuard(
  policy: AccessPolicy,
  guarded: (path: string) => boolean,
): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header("host") ?? new URL(c.req.url).host;
    if (!hostAllowed(host, policy)) {
      return c.text(
        `Host "${host}" is not allowed. Add it to TENZO_ALLOWED_HOSTS if it is this machine.\n`,
        403,
      );
    }
    if (guarded(c.req.path) && !originAllowed(c.req.header("origin"), policy)) {
      return c.text("Cross-origin requests are not allowed.\n", 403);
    }
    await next();
  };
}

function allowed(name: string, policy: AccessPolicy): boolean {
  return (
    (LOOPBACK_HOSTS as readonly string[]).includes(name) ||
    policy.allowedHosts.some((h) => normalize(h) === name)
  );
}

function hostname(url: string): string | null {
  try {
    return normalize(new URL(url).hostname);
  } catch {
    return null;
  }
}

/** Lower case, no trailing dot: `Example.COM.` and `example.com` are the same host. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/\.$/, "");
}
