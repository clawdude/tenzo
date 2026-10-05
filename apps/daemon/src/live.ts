import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import { connect } from "node:net";
import { isAbsolute, relative, sep } from "node:path";
import type { Duplex } from "node:stream";
import { type Device, LIVE_DOOR, liveBase, type Preview, ThreadId } from "@tenzo/contracts";
import { type Context, Hono, type MiddlewareHandler } from "hono";
import { type AccessPolicy, accessGuard, hostAllowed, originAllowed } from "./access.ts";
import {
  factsOf,
  factsOfIncoming,
  LIVE_COOKIE,
  liveCookie,
  type RequestFacts,
  readCookies,
  requestMode,
  setsTenzoCookie,
  withoutTenzoCookies,
} from "./auth.ts";
import type { Devices } from "./devices.ts";
import { TenzoError } from "./errors.ts";

/**
 * The live URL of a thread's dev server (Tenzo's `expose`), reachable from the phone:
 * `/live/<thread>/…` is forwarded to `localhost:<port>/live/<thread>/…`, the port the thread's
 * agent exposed and no other, HTTP and WebSocket (Vite's HMR) alike.
 *
 * It is served by a listener of its own (`TENZO_LIVE_PORT`, default the daemon's port + 1), never
 * by the daemon's: a page an agent serves runs whatever its dependencies, embeds and bugs put in
 * it, and on Tenzo's origin that code could call the API (answer permission cards, start
 * threads). On the live origin it can't: the daemon refuses its Origin, and the live listener
 * serves nothing but `/live/`. Same Host allowlist; an Origin is accepted only if it is the live
 * listener's own. Different threads' apps share the live origin with each other, never Tenzo's.
 * Over the tailnet that means a second Tailscale Serve route (`TENZO_LIVE_ORIGIN`).
 *
 * From elsewhere (remote mode, auth.ts) the live origin takes only its own credential: a cookie
 * holding a signed pass for a paired device, set by its door (`/_tenzo/live`) from the grant in
 * an Open live link. Cookies don't keep ports apart, so the browser sends Tenzo's own device
 * cookie here too: it is never taken here, and like the live cookie it is stripped from every
 * request before it reaches a dev server, and a dev server can't set either (its Set-Cookie for
 * them is dropped, WebSocket handshakes included). Revoking a device closes its live sockets too.
 *
 * The path is forwarded unchanged, so the dev server must serve under the thread's base
 * (`vite --base /live/<thread>/`, Next's `basePath`, …). An app that only works at `/` loads its
 * page but not its absolute `/assets/…`; `expose` warns the agent when the page it fetched
 * points outside the base.
 *
 * `expose` takes only a port whose listening process runs in the thread's worktree (`lsof`), and
 * never Tenzo itself.
 */

/** Set on every forwarded request; seen coming back in, it is a loop (the daemon's own port). */
export const LIVE_HEADER = "x-tenzo-live";

/** On every response of the daemon's listeners: a port that answers with it is Tenzo itself. */
export const DAEMON_HEADER = "x-tenzo-daemon";

/** Marks every response as Tenzo's (`DAEMON_HEADER`), refusals included. */
export function markDaemon(): MiddlewareHandler {
  return async (c, next) => {
    await next();
    c.res.headers.set(DAEMON_HEADER, "1");
  };
}

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
  if (response.headers.has(DAEMON_HEADER)) {
    await response.body?.cancel();
    throw new TenzoError(
      `localhost:${preview.port} is Tenzo itself, not a dev server. Expose the port your dev server listens on.`,
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

/** The working directories of the processes listening on `port`; null when that can't be asked. */
export type ListenerDirs = (port: number) => Promise<string[] | null>;

/** `ListenerDirs` from `lsof` (macOS, most Linux); null where it isn't installed. */
export const lsofListenerDirs: ListenerDirs = async (port) => {
  const pids = await lsof(["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fp"]);
  if (pids === null) return null;
  const list = [...pids.matchAll(/^p(\d+)$/gm)].map((m) => m[1] ?? "");
  if (list.length === 0) return [];
  const cwds = await lsof(["-a", "-p", list.join(","), "-d", "cwd", "-Fn"]);
  return [...(cwds ?? "").matchAll(/^n(.+)$/gm)].map((m) => m[1] ?? "");
};

/** Runs lsof; its output, "" when it found nothing (exit 1), null when there's no lsof. */
function lsof(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile("lsof", args, { timeout: 3000 }, (error, stdout) => {
      if (error && (error as NodeJS.ErrnoException).code === "ENOENT") resolve(null);
      else resolve(stdout ?? "");
    });
  });
}

/**
 * `expose` takes a port only if a process running in the thread's worktree listens on it: the
 * dev server the agent started there, not another local service (whose own Host and Origin
 * checks the proxy would otherwise get around) nor another thread's. Without lsof, unchecked.
 */
export async function checkListener(
  port: number,
  worktree: string,
  listenerDirs: ListenerDirs,
): Promise<void> {
  const dirs = await listenerDirs(port);
  if (dirs === null) return;
  const root = await realpath(worktree).catch(() => worktree);
  for (const dir of dirs) {
    const real = await realpath(dir).catch(() => dir);
    const rel = relative(root, real);
    if (rel === "" || (!isAbsolute(rel) && rel.split(sep)[0] !== "..")) return;
  }
  throw new TenzoError(
    dirs.length === 0
      ? `Can't tell which process listens on localhost:${port}. Expose a dev server you started in this worktree.`
      : `localhost:${port} is served by a process running in ${dirs.join(", ")}, outside this worktree. Expose a dev server you started here.`,
  );
}

/** Who may use live apps: the Mac itself, or a paired device by its live cookie. */
export function liveCaller(
  facts: RequestFacts,
  devices: Devices | undefined,
): { mode: "local" } | { mode: "remote"; device: Device } | null {
  if (requestMode(facts) === "local") return { mode: "local" };
  const device = liveCookieDevice(facts, devices);
  return device ? { mode: "remote", device } : null;
}

/** The device the request's live cookie names, trying each one under the name; null if none. */
function liveCookieDevice(facts: RequestFacts, devices: Devices | undefined): Device | null {
  for (const pass of readCookies(facts.header("cookie"), LIVE_COOKIE)) {
    const device = devices?.checkLivePass(pass);
    if (device) return device;
  }
  return null;
}

/**
 * Where the door may send the browser: a page under some thread's live base, as a plain path
 * (no `..` or `.` segment, encoded or not, no backslash, no control characters or spaces).
 */
export function doorTarget(to: string | undefined): string | null {
  if (!to || !/^\/live\/thr_[a-z0-9]{20}\/[^\\\s\u0000-\u001f\u007f]*$/.test(to)) return null;
  const path = to.split(/[?#]/)[0] ?? "";
  if (/%2e|%2f|%5c/i.test(path)) return null;
  if (path.split("/").some((segment) => segment === ".." || segment === ".")) return null;
  return to;
}

/** What a browser from elsewhere gets without the live origin's cookie. */
function notPaired(c: Context, why: string): Response {
  return c.html(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tenzo · live app</title><body style="margin:0;padding:32px 24px;background:#000;color:#f5f5f7;font:17px/1.4 -apple-system,system-ui,sans-serif"><h1 style="font-size:28px">Open it from Tenzo</h1><p style="color:#8e8e93">${why} Open live on a finished card opens it, on a device paired with <code>tenzo pair</code>.</p></body>`,
    401,
    { "Cache-Control": "no-store" },
  );
}

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
      if (HOP_BY_HOP.has(key) || key === "host" || key === "accept-encoding") return;
      if (key === "cookie") {
        // Tenzo's cookies are Tenzo's: a dev server never sees them.
        const kept = withoutTenzoCookies(value);
        if (kept !== null) headers.set(key, kept);
        return;
      }
      headers.set(key, value);
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
    if (upstream.headers.has(DAEMON_HEADER)) {
      await upstream.body?.cancel();
      return c.text("A live URL can't point at Tenzo itself.\n", 508);
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
    for (const cookie of upstream.headers.getSetCookie()) {
      if (!setsTenzoCookie(cookie)) out.append("set-cookie", cookie);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: out,
    });
  };
}

/**
 * The live listener's HTTP side: `/live/<thread>/…` and nothing else. Every request is checked
 * like the daemon's (Host allowlist), and a request with an Origin must come from the live
 * origin itself, never from Tenzo's pages or anyone else's.
 */
export function createLiveApp(options: {
  policy: AccessPolicy;
  portOf: LivePort;
  devices?: Devices | undefined;
}): Hono {
  const app = new Hono();
  app.use("*", markDaemon());
  app.use("*", accessGuard({ allowedHosts: options.policy.allowedHosts }, () => true));
  // The door: an Open live link's grant (a paired device's, from its snapshot) for the live
  // origin's cookie, then on to the page. Nothing else here sets a cookie.
  app.get(LIVE_DOOR, (c) => {
    const to = doorTarget(c.req.query("to"));
    if (!to) return c.text("Open live links go to a thread's live app.\n", 400);
    const facts = factsOf(c);
    if (requestMode(facts) === "local") return c.redirect(to, 303);
    const devices = options.devices;
    const granted = devices?.checkLivePass(c.req.query("grant")) ?? null;
    const holding = liveCookieDevice(facts, devices);
    const onward = (setCookie?: string) =>
      new Response(null, {
        status: 303,
        headers: {
          location: to,
          ...(setCookie ? { "set-cookie": setCookie } : {}),
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
        },
      });
    if (granted && devices) {
      // (Re)issued for the granted device, whatever cookie the browser held: Safari paired as one
      // device may well open the links of a home-screen app paired as another.
      const { pass, expiresAt } = devices.livePass(granted.id);
      return onward(liveCookie(pass, expiresAt));
    }
    // The grant ran out (a page left open for long), but this browser holds a good live cookie.
    if (holding) return onward();
    return notPaired(c, "This link has expired, or this device isn't paired.");
  });
  app.use("/live/*", async (c, next) => {
    if (!liveCaller(factsOf(c), options.devices)) {
      return notPaired(c, "Live apps are for devices paired with Tenzo.");
    }
    await next();
  });
  app.all("/live/:thread", (c) => {
    const thread = c.req.param("thread");
    if (!ThreadId.safeParse(thread).success) return c.text("This thread has no live app.\n", 404);
    return c.redirect(liveBase(thread), 308);
  });
  app.all("/live/:thread/*", liveHandler(options.portOf));
  app.all("*", (c) => c.text("Only threads' live apps are served here.\n", 404));
  return app;
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
  options: { policy: AccessPolicy; portOf: LivePort; devices?: Devices | undefined },
): void {
  const refuse = (status: number, reason: string) => {
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  };
  const host = request.headers.host;
  const origin = request.headers.origin;
  // Only the live origin itself: no dev origins, never Tenzo's own pages.
  const policy = { allowedHosts: options.policy.allowedHosts };
  if (!hostAllowed(host, policy) || !originAllowed(origin, host, policy)) {
    return refuse(403, "Forbidden");
  }
  if (request.headers[LIVE_HEADER]) return refuse(508, "Loop Detected");
  const caller = liveCaller(factsOfIncoming(request), options.devices);
  if (!caller) return refuse(401, "Unauthorized");
  const threadId = /^\/live\/([^/?#]+)\//.exec(request.url ?? "")?.[1] ?? "";
  const port = ThreadId.safeParse(threadId).success ? options.portOf(threadId) : null;
  if (port === null) return refuse(404, "Not Found");

  const upstream = connect({ host: "localhost", port, autoSelectFamily: true });
  const lines = [`${request.method ?? "GET"} ${request.url} HTTP/1.1`];
  const raw = request.rawHeaders;
  for (let i = 0; i + 1 < raw.length; i += 2) {
    const key = (raw[i] ?? "").toLowerCase();
    if (key === "host" || key === "origin" || key === LIVE_HEADER) continue;
    if (key === "cookie") {
      const kept = withoutTenzoCookies(raw[i + 1]);
      if (kept !== null) lines.push(`${raw[i]}: ${kept}`);
      continue;
    }
    lines.push(`${raw[i]}: ${raw[i + 1]}`);
  }
  lines.push(`Host: localhost:${port}`, `${LIVE_HEADER}: 1`);
  if (origin) lines.push(`Origin: http://localhost:${port}`);
  let connected = false;
  // A revoked device's live sockets close with its other connections.
  const untrack =
    caller.mode === "remote" && options.devices
      ? options.devices.track(caller.device.id, () => {
          socket.destroy();
          upstream.destroy();
        })
      : () => {};
  upstream.once("connect", () => {
    connected = true;
    upstream.write(`${lines.join("\r\n")}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream);
    // The handshake's answer without any Tenzo cookie it tries to set; then the bytes as they come.
    let held = Buffer.alloc(0);
    const onHead = (chunk: Buffer) => {
      held = Buffer.concat([held, chunk]);
      const end = held.indexOf("\r\n\r\n");
      if (end < 0) {
        if (held.length > 64 * 1024) socket.destroy();
        return;
      }
      upstream.off("data", onHead);
      socket.write(Buffer.from(withoutTenzoSetCookie(held.subarray(0, end).toString("latin1")), "latin1"));
      socket.write(held.subarray(end));
      upstream.pipe(socket);
    };
    upstream.on("data", onHead);
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
  socket.once("close", () => {
    untrack();
    upstream.destroy();
  });
}

/** An HTTP response head without the `Set-Cookie` lines that set Tenzo's cookies. */
export function withoutTenzoSetCookie(head: string): string {
  return head
    .split("\r\n")
    .filter((line) => {
      const colon = line.indexOf(":");
      if (colon < 0 || line.slice(0, colon).trim().toLowerCase() !== "set-cookie") return true;
      return !setsTenzoCookie(line.slice(colon + 1).trim());
    })
    .join("\r\n");
}
