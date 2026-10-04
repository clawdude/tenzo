import type { IncomingMessage } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { liveBase, type Preview, ThreadId } from "@tenzo/contracts";
import type { Context } from "hono";
import { type AccessPolicy, hostAllowed, originAllowed } from "./access.ts";
import { TenzoError } from "./errors.ts";

/**
 * The live URL of a thread's dev server (Tenzo's `expose`), reachable from the phone through the
 * daemon's own origin: `/live/<thread>/…` is forwarded to `localhost:<port>/live/<thread>/…`,
 * the port the thread's agent exposed and no other, HTTP and WebSocket (Vite's HMR) alike, behind
 * the same access guard as everything else. One origin means one Tailscale Serve route: no new
 * port to publish, no tailnet config.
 *
 * The path is forwarded unchanged, so the dev server must serve under the thread's base
 * (`vite --base /live/<thread>/`, Next's `basePath`, …). An app that only works at `/` loads its
 * page but not its absolute `/assets/…`; `expose` warns the agent when the page it fetched
 * points outside the base.
 *
 * The app runs on Tenzo's origin. That is fine while the daemon has no credentials of its own
 * (loopback, the tailnet): the agent that wrote the app can already reach the daemon. Remote
 * mode with device tokens (M4) must move it to an origin of its own.
 */

/** Set on every forwarded request; seen coming back in, it is a loop (the daemon's own port). */
export const LIVE_HEADER = "x-tenzo-live";

/** The lowest port `expose` takes: dev servers don't run on privileged ports. */
export const MIN_PORT = 1024;
const PATH_LIMIT = 300;
const PROBE_TIMEOUT_MS = 3000;

/** Finds the port a thread's live base goes to: null for an unknown thread or none exposed. */
export type LivePort = (threadId: string) => number | null;

/** A port `expose` takes, or a TenzoError saying why not. */
export function checkPort(port: number): number {
  if (!Number.isInteger(port) || port < MIN_PORT || port > 65_535) {
    throw new TenzoError(`Expose a dev server's port, ${MIN_PORT}–65535; got ${port}.`);
  }
  return port;
}

/**
 * The page under the live base, as stored: no leading slash, no way out of the base (`..`,
 * a scheme, a backslash), printable. "" is the base itself.
 */
export function livePath(path: string | undefined): string {
  const trimmed = (path ?? "").trim().replace(/^\/+/, "");
  if (trimmed.length > PATH_LIMIT) throw new TenzoError("That path is too long.");
  if (
    /[\\\s\u0000-\u001f\u007f]/.test(trimmed) ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ||
    trimmed.split(/[/?#]/).includes("..")
  ) {
    throw new TenzoError(
      `"${path}" is not a page under the live base: give a path like "counter" or "?tab=2".`,
    );
  }
  return trimmed;
}

/**
 * Checks what `expose` is about to register: something answers on the port at the page, and the
 * page doesn't point at absolute paths outside the base. Returns a warning for the agent (the
 * port is still exposed), or throws a TenzoError when nothing answers.
 */
export async function probeLive(threadId: string, preview: Preview): Promise<string | null> {
  const base = liveBase(threadId);
  let response: Response;
  try {
    response = await fetch(`http://localhost:${preview.port}${base}${preview.path}`, {
      headers: { [LIVE_HEADER]: "probe", accept: "text/html,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch {
    throw new TenzoError(
      `Nothing answers on localhost:${preview.port}. Start the dev server first, in the background so it keeps running, serving under ${base} (Vite: \`--base ${base}\`), then expose it again.`,
    );
  }
  if (response.status >= 400) {
    await response.body?.cancel();
    return `localhost:${preview.port} answered ${base}${preview.path} with ${response.status}. Serve the app under ${base} (Vite: \`--base ${base}\`) so the person's link works.`;
  }
  const type = response.headers.get("content-type") ?? "";
  if (!type.includes("html")) {
    await response.body?.cancel();
    return null;
  }
  const outside = outsideBase(await response.text(), base);
  return outside
    ? `The page loads ${outside}, outside ${base}: through Tenzo that won't load. Serve the app under ${base} (Vite: \`--base ${base}\`).`
    : null;
}

/** The first `src` or `href` in `html` that is an absolute path outside `base`, if any. */
export function outsideBase(html: string, base: string): string | null {
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"']*)["']/gi)) {
    const url = match[1] ?? "";
    if (url.startsWith("/") && !url.startsWith("//") && !url.startsWith(base)) return url;
  }
  return null;
}

/** Request headers that describe the hop, not the request. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Response headers the app may not send through Tenzo's origin: a service worker allowed beyond
 * its own path, or wiping the origin's storage (Tenzo's too).
 */
const BLOCKED_RESPONSE = new Set(["service-worker-allowed", "clear-site-data"]);

/** `/live/<thread>/…` over HTTP: a Hono handler, behind the access guard. */
export function liveHandler(portOf: LivePort) {
  return async (c: Context): Promise<Response> => {
    const threadId = c.req.param("thread") ?? "";
    if (c.req.header(LIVE_HEADER)) return c.text("A live URL can't point at Tenzo itself.\n", 508);
    // A WebSocket upgrade is the server's (`liveUpgrade`): nothing to do over plain HTTP.
    if (c.req.header("upgrade")?.toLowerCase() === "websocket") return c.body(null, 426);
    const port = ThreadId.safeParse(threadId).success ? portOf(threadId) : null;
    if (port === null) return c.text("This thread has no live app.\n", 404);

    const url = new URL(c.req.url);
    const headers = new Headers();
    c.req.raw.headers.forEach((value, key) => {
      if (!HOP_BY_HOP.has(key) && key !== "host" && key !== "accept-encoding") {
        headers.set(key, value);
      }
    });
    // The dev server sees a request from its own machine, as if opened there: dev servers
    // refuse a foreign Host (DNS-rebinding checks); the access guard has already vetted it.
    if (headers.has("origin")) headers.set("origin", `http://localhost:${port}`);
    headers.set(LIVE_HEADER, "1");
    headers.set("accept-encoding", "identity");
    const hasBody = c.req.method !== "GET" && c.req.method !== "HEAD";
    let upstream: Response;
    try {
      upstream = await fetch(`http://localhost:${port}${url.pathname}${url.search}`, {
        method: c.req.method,
        headers,
        redirect: "manual",
        ...(hasBody ? { body: c.req.raw.body, duplex: "half" } : {}),
      } as RequestInit);
    } catch {
      return c.text(
        `Nothing is running on port ${port} for this thread: its dev server has stopped. Ask the agent to start it again.\n`,
        502,
      );
    }
    const out = new Headers();
    const encoded = upstream.headers.has("content-encoding");
    upstream.headers.forEach((value, key) => {
      if (HOP_BY_HOP.has(key) || BLOCKED_RESPONSE.has(key)) return;
      // fetch has decoded the body already: its encoding and length no longer hold.
      if (encoded && (key === "content-encoding" || key === "content-length")) return;
      if (key === "set-cookie") return; // appended one by one below
      out.set(key, key === "location" ? sameOriginLocation(value, port) : value);
    });
    for (const cookie of upstream.headers.getSetCookie()) out.append("set-cookie", cookie);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  };
}

/** A redirect to the dev server's own address, made relative so it stays on Tenzo's origin. */
function sameOriginLocation(location: string, port: number): string {
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    const prefix = `http://${host}:${port}`;
    if (location.startsWith(`${prefix}/`)) return location.slice(prefix.length);
  }
  return location;
}

/** True when a request path is under some thread's live base. */
export function isLivePath(url: string | undefined): boolean {
  return (url ?? "").startsWith("/live/");
}

/**
 * A WebSocket upgrade under `/live/<thread>/`: checked like any request (Host, Origin), then
 * piped to the thread's port as raw bytes, the handshake included. Anything else is refused.
 */
export function liveUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options: { policy: AccessPolicy; portOf: LivePort },
): void {
  const refuse = (status: number, reason: string) => {
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  };
  const host = request.headers.host;
  const origin = request.headers.origin;
  if (!hostAllowed(host, options.policy) || !originAllowed(origin, host, options.policy)) {
    return refuse(403, "Forbidden");
  }
  if (request.headers[LIVE_HEADER]) return refuse(508, "Loop Detected");
  const threadId = /^\/live\/([^/?#]+)\//.exec(request.url ?? "")?.[1] ?? "";
  const port = ThreadId.safeParse(threadId).success ? options.portOf(threadId) : null;
  if (port === null) return refuse(404, "Not Found");

  const upstream = connect({ host: "localhost", port, autoSelectFamily: true });
  const lines = [`${request.method ?? "GET"} ${request.url} HTTP/1.1`];
  const raw = request.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const key = (raw[i] ?? "").toLowerCase();
    if (key === "host" || key === "origin" || key === LIVE_HEADER) continue;
    lines.push(`${raw[i]}: ${raw[i + 1]}`);
  }
  lines.push(`Host: localhost:${port}`, `${LIVE_HEADER}: 1`);
  if (origin) lines.push(`Origin: http://localhost:${port}`);
  let connected = false;
  upstream.once("connect", () => {
    connected = true;
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => {
    // Nothing listening: say so. Mid-connection: the pipe just ends.
    if (!connected) refuse(502, "Bad Gateway");
    else socket.destroy();
  });
  upstream.once("close", () => {
    if (connected) socket.destroy();
  });
  socket.on("error", () => upstream.destroy());
  socket.once("close", () => upstream.destroy());
}
