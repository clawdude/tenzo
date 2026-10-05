import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  Command,
  type CommandResponse,
  type EnvironmentId,
  type Health,
  PairRequest,
  type PairResponse,
  pairingCode,
  type Session,
} from "@tenzo/contracts";
import { type Context, Hono } from "hono";
import pkg from "../package.json" with { type: "json" };
import { accessGuard, securityHeaders } from "./access.ts";
import { storedAttachment } from "./attachments.ts";
import {
  DEVICE_COOKIE,
  deviceCookie,
  factsOf,
  fromOwnPage,
  readCookies,
  requestMode,
} from "./auth.ts";
import { type Caller, executeCommand } from "./commands.ts";
import { type Devices, nameFromUserAgent } from "./devices.ts";
import type { Engine } from "./engine.ts";
import { markDaemon } from "./live.ts";
import { socketHandlers } from "./socket.ts";

export const VERSION: string = pkg.version;

export interface AppOptions {
  environmentId: EnvironmentId;
  /** The built web app. Served from the same origin so Tailscale Serve needs one proxy. */
  webDir: string;
  /** Runs `/api/commands` and feeds `/ws`. Without one, the API answers 503. */
  engine?: Engine;
  /** Host names besides loopback that may reach the daemon (access.ts). */
  allowedHosts?: readonly string[];
  /** Dev servers whose pages may call (access.ts). */
  devOrigins?: readonly string[];
  /** Paired devices (devices.ts). Without them, nothing from elsewhere gets in. */
  devices?: Devices | undefined;
  /** How often a paired device's socket gets a fresh Open live grant; tests shorten it. */
  liveGrantRenewMs?: number | undefined;
}

/** What a request carries through the app: who asked (set for the API and /ws). */
export type AppEnv = { Variables: { caller: Caller | undefined } };

const UNPAIRED =
  "This device isn't paired with Tenzo. On the Mac, run `tenzo pair` and open its link here.";

/**
 * Who is asking (auth.ts): the Mac itself, or a paired device by its cookie, taken only from
 * Tenzo's own pages. Null: from elsewhere, and not paired.
 */
function callerOf(c: Context, devices: Devices | undefined): Caller | null {
  if (requestMode(factsOf(c)) === "local") return { mode: "local", device: null };
  if (!devices || !fromOwnPage(c.req.header("sec-fetch-site"))) return null;
  // Every value under the name: a cookie planted beside ours must not shadow the one that verifies.
  for (const token of readCookies(c.req.header("cookie"), DEVICE_COOKIE)) {
    const device = devices.authenticate(token);
    if (device) return { mode: "remote", device };
  }
  return null;
}

/**
 * The daemon's HTTP surface: `/health`, `POST /api/commands`, the `/ws` WebSocket, attached
 * screenshots under `/api/attachments/`, and the web app with an SPA fallback. WebSockets only
 * upgrade when served by `startDaemon` (it needs the Node server). A foreign `Host` is refused
 * everywhere, a foreign `Origin` on the API and `/ws`. Threads' live apps are never served here:
 * they have a listener and an origin of their own (live.ts), so their pages can't call the API.
 */
export function createApp({
  environmentId,
  webDir,
  engine,
  allowedHosts = [],
  devOrigins = [],
  devices,
  liveGrantRenewMs,
}: AppOptions): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use("*", markDaemon());
  // No page frames the Pass: not a live page, not any website (access.ts).
  app.use("*", securityHeaders());
  app.use(
    "*",
    accessGuard(
      { allowedHosts, devOrigins },
      (path) => path === "/ws" || path.startsWith("/api/"),
    ),
  );
  // Remote mode (auth.ts): the API, attachments and /ws only for a paired device. The web app's
  // files hold no data and stay open, so an unpaired phone gets the page that says how to pair.
  app.use("*", async (c, next) => {
    const path = c.req.path;
    if (path !== "/ws" && !path.startsWith("/api/")) return next();
    const caller = callerOf(c, devices);
    c.set("caller", caller ?? undefined);
    if (!caller && path !== "/api/session" && path !== "/api/pair") {
      if (path === "/ws") return c.text(`${UNPAIRED}\n`, 401);
      return c.json({ ok: false, error: UNPAIRED } satisfies CommandResponse, 401);
    }
    await next();
  });

  app.get("/health", (c) => c.json({ ok: true, version: VERSION, environmentId } satisfies Health));

  app.post("/api/commands", async (c) => {
    const fail = (error: string, status: 400 | 415 | 500 | 503) =>
      c.json({ ok: false, error } satisfies CommandResponse, status);
    // JSON only: a form post can't fake it without a CORS preflight, which the daemon never grants.
    const mediaType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") {
      return fail("Send the command as application/json.", 415);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail("The body is not JSON.", 400);
    }
    const parsed = Command.safeParse(body);
    if (!parsed.success) {
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`);
      return fail(`Not a command: ${issues.join("; ")}`, 400);
    }
    if (!engine && !parsed.data.type.startsWith("device.")) {
      return fail("This daemon runs no threads.", 503);
    }
    const outcome = await executeCommand(engine, parsed.data, { devices, caller: c.var.caller });
    if (outcome.ok) return c.json({ ok: true, result: outcome.result } satisfies CommandResponse);
    return fail(outcome.error, outcome.fault === "client" ? 400 : 500);
  });
  // Who this browser is to the daemon: on the Mac, a paired device, or neither (then the web app
  // shows how to pair). Open to all; it says nothing else.
  app.get("/api/session", (c) => {
    const session: Session = {
      mode: requestMode(factsOf(c)),
      device: c.var.caller?.device ?? null,
    };
    return c.json(session, 200, { "Cache-Control": "no-store" });
  });

  // A pairing link's code for this browser's own token, as a cookie (auth.ts). A POST from the
  // page, never the link's GET: the code is in the link's fragment, which no request carries.
  app.post("/api/pair", async (c) => {
    const fail = (
      error: string,
      status: 400 | 415 | 429 | 503,
      headers: Record<string, string> = {},
    ) =>
      c.json({ ok: false, error } satisfies PairResponse, status, {
        "Cache-Control": "no-store",
        ...headers,
      });
    const mediaType = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
    if (mediaType !== "application/json") return fail("Send the code as application/json.", 415);
    if (!devices) return fail("This daemon pairs no devices.", 503);
    if (devices.pairingAttempts.blocked()) {
      return fail(
        "Too many failed pairing attempts. On the Mac, run `tenzo pair` for a new link (that lifts this), or wait a minute.",
        429,
        { "Retry-After": String(devices.pairingAttempts.retryAfter()) },
      );
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return fail("The body is not JSON.", 400);
    }
    const parsed = PairRequest.safeParse(body);
    const code = parsed.success ? pairingCode(parsed.data.code) : null;
    const name = parsed.data?.name ?? nameFromUserAgent(c.req.header("user-agent"));
    const paired = code ? devices.exchange(code, name) : null;
    if (!paired) {
      devices.pairingAttempts.fail();
      return fail(
        "This pairing link has expired or was already used. On the Mac, run `tenzo pair` for a new one.",
        400,
      );
    }
    return c.json({ ok: true, device: paired.device } satisfies PairResponse, 200, {
      "Set-Cookie": deviceCookie(paired.token),
      "Cache-Control": "no-store",
    });
  });

  // A screenshot an agent attached: only the daemon's own copies, by well-formed names
  // (attachments.ts), served so that nothing in one can run: images only, never sniffed, and a
  // sandbox if one is opened on its own.
  app.get("/api/attachments/:thread/:file", async (c) => {
    const stored = engine
      ? storedAttachment(engine.store.home, c.req.param("thread"), c.req.param("file"))
      : null;
    let bytes: Buffer | null = null;
    if (stored) bytes = await readFile(stored.path).catch(() => null);
    if (!stored || !bytes) return c.text("No such attachment.\n", 404);
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": stored.mediaType,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      // A copy never changes: its name is new for every attach.
      "Cache-Control": "private, max-age=31536000, immutable",
    });
  });
  app.all("/api/*", (c) => c.json({ ok: false, error: "No such API." } satisfies CommandResponse, 404));

  // Live apps are on the live listener (live.ts), never on this origin; WebSocket upgrades here
  // get the same 404.
  const elsewhere = (c: Context) =>
    c.text("Threads' live apps are served on Tenzo's live port, not here.\n", 404);
  app.all("/live", elsewhere);
  app.all("/live/*", elsewhere);

  // The access guard above has already refused a foreign Host or Origin before any upgrade.
  app.get(
    "/ws",
    upgradeWebSocket((c) =>
      socketHandlers({
        environmentId,
        version: VERSION,
        engine,
        devices,
        caller: c.var.caller,
        liveGrantRenewMs,
      }),
    ),
  );

  // SvelteKit content-hashes everything under _app/immutable; everything else must revalidate.
  // Decided after the route answers: a 404 for a missing hashed asset must not be cached for a year.
  app.use("*", async (c, next) => {
    await next();
    const found = c.res.ok || c.res.status === 304;
    const immutable = c.req.path.startsWith("/_app/immutable/") && found;
    c.res.headers.set(
      "Cache-Control",
      immutable ? "public, max-age=31536000, immutable" : "no-cache",
    );
  });
  app.use("*", serveStatic({ root: webDir }));

  // SPA fallback: client routes get index.html; a missing asset stays a 404.
  app.get("*", async (c) => {
    if (extname(c.req.path) !== "") return c.notFound();
    try {
      const html = await readFile(join(webDir, "index.html"), "utf8");
      return c.html(html);
    } catch {
      return c.text("Tenzo's web app is not built yet. Run `pnpm build`, then restart.\n", 503);
    }
  });

  return app;
}
