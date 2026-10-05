import type { MiddlewareHandler } from "hono";

/**
 * Who may talk to the daemon over HTTP and WebSocket. It listens on loopback, but a web page in
 * the person's own browser can still reach loopback: by DNS rebinding (an attacker's name that
 * resolves to 127.0.0.1, so the browser calls it same-origin) or by a cross-site request. A
 * WebSocket has no CORS preflight at all, so any page could open `/ws`. Since the API starts
 * agents and answers for you, both are refused:
 *
 * - the `Host` must name this machine: 127.0.0.1, localhost, ::1, or a configured name such as
 *   the Tailscale Serve host (`TENZO_ALLOWED_HOSTS`);
 * - a request that carries an `Origin` (every browser request that matters does, WebSocket
 *   upgrades included) must come from the daemon's own pages: the very host and port it was
 *   reached at (over https for a configured host, e.g. Tailscale Serve on :8443), or a dev
 *   server named in
 *   `TENZO_DEV_ORIGIN`. Not any other localhost port: that is someone else's dev server, a local
 *   tool's UI, or a package's page. Requests without an Origin are not from a web page: the
 *   CLI, curl.
 */
export const LOOPBACK_HOSTS = ["127.0.0.1", "localhost", "[::1]"] as const;

export interface AccessPolicy {
  /** Hostnames allowed besides loopback, e.g. `my-mac.tailnet.ts.net`. */
  allowedHosts: readonly string[];
  /** Exact origins of dev servers whose pages may call, e.g. `http://localhost:5173`. */
  devOrigins?: readonly string[];
}

/** True when a `Host` header names this machine. The port doesn't matter; the name does. */
export function hostAllowed(host: string | undefined, policy: AccessPolicy): boolean {
  if (!host) return false;
  const name = hostname(`http://${host}`);
  return name !== null && hostKnown(name, policy);
}

/**
 * True when a request reached at `host` may come from `origin`: absent (not a browser), the same
 * origin, a configured host over https, or a configured dev origin.
 */
export function originAllowed(
  origin: string | undefined,
  host: string | undefined,
  policy: AccessPolicy,
): boolean {
  if (origin === undefined) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // "null" (sandboxed frames, file:) and garbage
  }
  if (url.origin === "null") return false;
  if (policy.devOrigins?.some((dev) => sameOrigin(dev, url.origin))) return true;
  const name = normalize(url.hostname);
  if (url.protocol === "http:" && (LOOPBACK_HOSTS as readonly string[]).includes(name)) {
    // The daemon's own page: exactly the host and port this request came in on.
    return host !== undefined && url.host.toLowerCase() === host.toLowerCase();
  }
  if (url.protocol === "https:" && policy.allowedHosts.some((h) => normalize(h) === name)) {
    // A configured host behind an https proxy (Tailscale Serve, any port): the page must be
    // the one this request came in for, so its host and port equal the Host header exactly.
    return host !== undefined && normalizeHost(url.host) === normalizeHost(host);
  }
  return false;
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
    if (guarded(c.req.path) && !originAllowed(c.req.header("origin"), host, policy)) {
      return c.text(
        "Cross-origin requests are not allowed. A dev server's origin goes in TENZO_DEV_ORIGIN.\n",
        403,
      );
    }
    await next();
  };
}

/**
 * On every response of the daemon's own listener: no page may frame it. A live page is same-site
 * (cookies ignore ports), so a frame of the Pass there loads with the device's cookie and every
 * check passes inside it; an invisible one under a decoy button would answer cards with your tap.
 * On the Mac, any website could frame the login-free Pass the same way (Safari lets it). Also:
 * nothing is sniffed into another type, and no Referer leaves the Pass (thread names, ids).
 */
export function securityHeaders(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    const headers = c.res.headers;
    const csp = headers.get("content-security-policy");
    if (!csp) headers.set("content-security-policy", "frame-ancestors 'none'");
    else if (!/frame-ancestors/i.test(csp)) {
      headers.set("content-security-policy", `${csp}; frame-ancestors 'none'`);
    }
    headers.set("x-frame-options", "DENY");
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "no-referrer");
  };
}

function hostKnown(name: string, policy: AccessPolicy): boolean {
  return (
    (LOOPBACK_HOSTS as readonly string[]).includes(name) ||
    policy.allowedHosts.some((h) => normalize(h) === name)
  );
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function hostname(url: string): string | null {
  try {
    return normalize(new URL(url).hostname);
  } catch {
    return null;
  }
}

/**
 * A `host[:port]` compared as a browser would: lower case, no trailing dot on the name, and no
 * `:443`, which an https Origin never spells out.
 */
function normalizeHost(hostPort: string): string {
  try {
    const url = new URL(`https://${hostPort}`);
    return url.port === "" ? normalize(url.hostname) : `${normalize(url.hostname)}:${url.port}`;
  } catch {
    return hostPort.toLowerCase();
  }
}

/** Lower case, no trailing dot: `Example.COM.` and `example.com` are the same host. */
function normalize(name: string): string {
  return name.toLowerCase().replace(/\.$/, "");
}
