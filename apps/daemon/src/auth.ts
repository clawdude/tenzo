import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { DeviceId } from "@tenzo/contracts";
import type { Context } from "hono";
import { LOOPBACK_HOSTS } from "./access.ts";

/**
 * Who is asking: the Mac itself (local mode, no login), or a device elsewhere (remote mode, which
 * must be paired). PRODUCT.md §9.
 *
 * The daemon listens on loopback only, so everything from elsewhere arrives through a proxy on
 * this Mac: Tailscale Serve, which connects from 127.0.0.1. The socket's address alone can't tell
 * the phone from the CLI, so a request is local only when all three hold:
 *
 * - its socket comes from loopback (nothing else can, today; this keeps it so if that changes);
 * - its `Host` names loopback (127.0.0.1, localhost, [::1]). Tailscale Serve passes on the name
 *   the phone used (`my-mac.tailnet.ts.net`), so its requests fail this: any allowed non-loopback
 *   host is remote, whatever socket it came in on;
 * - it carries no proxy's forwarding header (`X-Forwarded-For`, `Forwarded`, Tailscale's
 *   `Tailscale-User-*`, …). Tailscale Serve sets `X-Forwarded-For` and `X-Forwarded-Host` on every
 *   request, so a phone that sends `Host: localhost` through it is still remote. A proxy that
 *   rewrites Host to loopback *and* drops every forwarding header would make its clients local.
 *   So does anything that forwards raw TCP: `tailscale serve --tcp` or `--tls-terminated-tcp`,
 *   `socat`, `ssh -R`, an ngrok TCP tunnel. They add no headers and let the client say
 *   `Host: localhost`, so **every** client through them is local, with no pairing. Put Tenzo
 *   behind `tailscale serve --https` (an HTTP proxy) only. (`ssh -L` from elsewhere is local too:
 *   that is the Mac's own login.)
 *
 * Spoofing the other way, a local process sending a tailnet Host or a forwarding header, only
 * makes it remote: it then needs a paired device's token like anyone else. Nothing is trusted
 * from a header that grants more.
 */
export type Mode = "local" | "remote";

export interface RequestFacts {
  /** The socket's remote address, as Node reports it; undefined when unknown. */
  peer: string | undefined;
  /** The `Host` header. */
  host: string | undefined;
  /** Any request header, by lower-case name. */
  header: (name: string) => string | undefined;
}

/** Headers a proxy adds: any one of them means the request came from elsewhere. */
export const FORWARDING_HEADERS = [
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-forwarded-port",
  "x-real-ip",
  "via",
  "tailscale-user-login",
  "tailscale-user-name",
  "tailscale-user-profile-pic",
  "tailscale-app-capabilities",
] as const;

/** The facts of a request Hono serves on Node (`c.env.incoming` is Node's request). */
export function factsOf(c: Context): RequestFacts {
  const env = c.env as { incoming?: IncomingMessage } | undefined;
  return {
    peer: env?.incoming?.socket?.remoteAddress,
    host: c.req.header("host") ?? new URL(c.req.url).host,
    header: (name) => c.req.header(name),
  };
}

/** The facts of a raw Node request (a WebSocket upgrade). */
export function factsOfIncoming(request: IncomingMessage): RequestFacts {
  return {
    peer: request.socket.remoteAddress,
    host: request.headers.host,
    header: (name) => {
      const value = request.headers[name];
      return Array.isArray(value) ? value.join(", ") : value;
    },
  };
}

export function requestMode({ peer, host, header }: RequestFacts): Mode {
  if (!isLoopbackAddress(peer)) return "remote";
  if (!isLoopbackHost(host)) return "remote";
  if (FORWARDING_HEADERS.some((name) => header(name) !== undefined)) return "remote";
  return "local";
}

/** 127.0.0.0/8 and ::1, plain or IPv4-mapped. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const v4 = address.toLowerCase().replace(/^::ffff:/, "");
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4) || address === "::1";
}

/** A `Host` header (with or without a port) that names loopback. */
export function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  let name: string;
  try {
    name = new URL(`http://${host}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return false;
  }
  return (LOOPBACK_HOSTS as readonly string[]).includes(name);
}

// Credentials.

/**
 * A paired device's token, in a cookie only the daemon's own origin gets to use: `__Host-` (so
 * no Domain, Path=/, Secure, and a page can't plant one for a parent domain), HttpOnly (no
 * script reads it), SameSite=Strict (no other site's page sends it).
 *
 * Cookies ignore ports, so the browser sends it to the live listener too (same host, another
 * port): the live listener never takes it and strips it before anything reaches a dev server.
 * For the same reason SameSite can't keep a live page from sending it to the daemon (same site),
 * so the daemon takes it only from its own pages (`fromOwnPage`) and the Origin check refuses the
 * live origin.
 */
export const DEVICE_COOKIE = "__Host-tenzo";

/**
 * The live origin's own credential (live.ts): a signed pass naming the device. It grants threads'
 * live apps and nothing else; the daemon's listener never reads it.
 */
export const LIVE_COOKIE = "__Host-tenzo-live";

/** Cookies that are Tenzo's: never forwarded to a dev server, never set by one. */
export const TENZO_COOKIES: readonly string[] = [DEVICE_COOKIE, LIVE_COOKIE];

/**
 * How long a device's cookie lasts from pairing: long enough not to matter (browsers cap cookies
 * at 400 days anyway). Revoking ends it sooner.
 */
export const DEVICE_TTL_MS = 400 * 24 * 60 * 60_000;

/** How long the live origin's cookie lasts at most (never past the device's own); Open live renews it. */
export const LIVE_COOKIE_TTL_MS = 30 * 24 * 60 * 60_000;

/**
 * How long an Open live grant works. Short, so a shared Open live link is soon worthless; a paired
 * device's socket gets a fresh one every `LIVE_GRANT_RENEW_MS`.
 */
export const LIVE_GRANT_TTL_MS = 60 * 60_000;
export const LIVE_GRANT_RENEW_MS = 20 * 60_000;

export function deviceCookie(token: string): string {
  return `${DEVICE_COOKIE}=${token}; Path=/; Max-Age=${Math.floor(DEVICE_TTL_MS / 1000)}; Secure; HttpOnly; SameSite=Strict`;
}

/** The live origin's cookie with a pass that expires at `expiresAt` (ms), and not a moment later. */
export function liveCookie(pass: string, expiresAt: number, now: number = Date.now()): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - now) / 1000));
  return `${LIVE_COOKIE}=${pass}; Path=/; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
}

/**
 * A `Cookie` header's pairs. Split on commas too: several Cookie headers can arrive joined by
 * ", ", and a cookie of Tenzo's must never hide behind one (its values have no commas).
 */
function cookiePairs(header: string | undefined): { name: string; value: string; raw: string }[] {
  return (header ?? "")
    .split(/[;,]/)
    .map((raw) => raw.trim())
    .filter((raw) => raw !== "")
    .map((raw) => {
      const eq = raw.indexOf("=");
      return {
        name: (eq < 0 ? raw : raw.slice(0, eq)).trim(),
        value: eq < 0 ? "" : raw.slice(eq + 1).trim(),
        raw,
      };
    });
}

/** The value of cookie `name` in a `Cookie` header; the first one when it is there twice. */
export function readCookie(header: string | undefined, name: string): string | null {
  return cookiePairs(header).find((pair) => pair.name === name)?.value ?? null;
}

/**
 * Every value of cookie `name` in a `Cookie` header, in order: a cookie planted beside Tenzo's
 * (another path, say) must not shadow the one that verifies, so each is tried.
 */
export function readCookies(header: string | undefined, name: string): string[] {
  return cookiePairs(header)
    .filter((pair) => pair.name === name)
    .map((pair) => pair.value);
}

/** True for one of Tenzo's cookie names, in any case (browsers match `__Host-` so). */
function isTenzoCookie(name: string): boolean {
  return TENZO_COOKIES.some((ours) => ours.toLowerCase() === name.toLowerCase());
}

/** A `Cookie` header without Tenzo's cookies; null when nothing is left. */
export function withoutTenzoCookies(header: string | undefined): string | null {
  const kept = cookiePairs(header).filter((pair) => !isTenzoCookie(pair.name));
  return kept.length > 0 ? kept.map((pair) => pair.raw).join("; ") : null;
}

/** True when a `Set-Cookie` header sets one of Tenzo's cookies. */
export function setsTenzoCookie(setCookie: string): boolean {
  const pair = setCookie.split(";")[0] ?? "";
  const eq = pair.indexOf("=");
  const name = (eq < 0 ? pair : pair.slice(0, eq)).trim();
  if (isTenzoCookie(name)) return true;
  // Nameless (`=__Host-tenzo=x`): some browsers store it as `__Host-tenzo=x`.
  return name === "" && eq >= 0 && setsTenzoCookie(pair.slice(eq + 1));
}

/**
 * True when a request is from the daemon's own page (or no page: typed, a bookmark, the CLI), by
 * the browser's `Sec-Fetch-Site`. A live page is same-site but another origin: its requests say
 * `same-site`, and the device cookie they carry (cookies ignore ports) is not taken.
 *
 * Chromium sends no `Sec-Fetch-Site` on WebSocket handshakes, so for `/ws` the Origin check
 * (access.ts) is what refuses a live page. Framing is refused by `frame-ancestors` (access.ts).
 */
export function fromOwnPage(secFetchSite: string | undefined): boolean {
  return secFetchSite === undefined || secFetchSite === "same-origin" || secFetchSite === "none";
}

/** A new random token: 256 bits, URL- and cookie-safe. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** What the database keeps of a token. Tokens are random and long, so a plain hash is enough. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// Live passes: `<device id>.<expiry, ms>.<HMAC>`, checked without a lookup but for revocation.

export function signLivePass(key: Buffer, deviceId: string, expiresAt: number): string {
  const body = `${deviceId}.${expiresAt}`;
  return `${body}.${mac(key, body)}`;
}

/** The device a pass names, if it is Tenzo's, well formed and not expired. */
export function readLivePass(key: Buffer, pass: string | null | undefined, now: number): DeviceId | null {
  const [deviceId, expires, signature, extra] = (pass ?? "").split(".");
  if (!deviceId || !expires || !signature || extra !== undefined) return null;
  const expected = Buffer.from(mac(key, `${deviceId}.${expires}`));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  if (!/^\d+$/.test(expires) || Number(expires) <= now) return null;
  const id = DeviceId.safeParse(deviceId);
  return id.success ? id.data : null;
}

function mac(key: Buffer, body: string): string {
  return createHmac("sha256", key).update(`tenzo-live:${body}`).digest("base64url");
}

/**
 * At most `limit` failed attempts per `windowMs`, counted together for everyone: behind Tailscale
 * Serve every request comes from 127.0.0.1, and a client address from a header is the client's to
 * choose. Pairing codes are long enough that this is about cost, not guessing. Only failures
 * count, and the Mac lifts it (`reset`, on every `tenzo pair`), so a peer that keeps failing can't
 * lock the owner out.
 */
export class RateLimit {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  #failures: number[] = [];

  constructor(limit: number, windowMs: number, now: () => number = Date.now) {
    this.#limit = limit;
    this.#windowMs = windowMs;
    this.#now = now;
  }

  /** True while `limit` failures fall within the window: attempts wait. */
  blocked(): boolean {
    const now = this.#now();
    this.#failures = this.#failures.filter((t) => now - t < this.#windowMs);
    return this.#failures.length >= this.#limit;
  }

  /** Counts a failed attempt. */
  fail(): void {
    this.#failures.push(this.#now());
  }

  /** Forgets every failure. */
  reset(): void {
    this.#failures = [];
  }

  /** Seconds until an attempt would be taken again. */
  retryAfter(): number {
    const oldest = this.#failures[0];
    if (oldest === undefined || !this.blocked()) return 0;
    return Math.max(1, Math.ceil((oldest + this.#windowMs - this.#now()) / 1000));
  }
}
