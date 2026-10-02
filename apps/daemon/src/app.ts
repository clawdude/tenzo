import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import {
  ClientFrame,
  Command,
  type CommandResponse,
  type EnvironmentId,
  type Health,
  type ServerFrame,
} from "@tenzo/contracts";
import { Hono } from "hono";
import pkg from "../package.json" with { type: "json" };
import { accessGuard } from "./access.ts";
import { runCommand } from "./commands.ts";
import type { Engine } from "./engine.ts";
import { TenzoError } from "./errors.ts";

export const VERSION: string = pkg.version;

export interface AppOptions {
  environmentId: EnvironmentId;
  /** The built web app. Served from the same origin so Tailscale Serve needs one proxy. */
  webDir: string;
  /** Runs `/api/commands`. Without one, the API answers 503. */
  engine?: Engine;
  /** Host names besides loopback that may reach the daemon (access.ts). */
  allowedHosts?: readonly string[];
}

/**
 * The daemon's HTTP surface: `/health`, `POST /api/commands`, the `/ws` WebSocket, and the web
 * app with an SPA fallback. The WebSocket only upgrades when served by `startDaemon` (it needs the
 * Node server). A foreign `Host` is refused everywhere, a foreign `Origin` on the API and `/ws`.
 */
export function createApp({ environmentId, webDir, engine, allowedHosts = [] }: AppOptions): Hono {
  const app = new Hono();

  app.use(
    "*",
    accessGuard({ allowedHosts }, (path) => path === "/ws" || path.startsWith("/api/")),
  );

  app.get("/health", (c) => c.json({ ok: true, version: VERSION, environmentId } satisfies Health));

  app.post("/api/commands", async (c) => {
    const fail = (error: string, status: 400 | 415 | 500 | 503) =>
      c.json({ ok: false, error } satisfies CommandResponse, status);
    // JSON only: a form post can't fake it without a CORS preflight, which the daemon never grants.
    if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) {
      return fail("Send the command as application/json.", 415);
    }
    if (!engine) return fail("This daemon runs no threads.", 503);
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
    try {
      const result = await runCommand(engine, parsed.data);
      return c.json({ ok: true, result } satisfies CommandResponse);
    } catch (error) {
      if (error instanceof TenzoError) return fail(error.message, 400);
      console.error(`tenzo: ${parsed.data.type} failed:`, error);
      return fail(`${parsed.data.type} failed: ${String(error)}`, 500);
    }
  });
  app.all("/api/*", (c) => c.json({ ok: false, error: "No such API." } satisfies CommandResponse, 404));

  app.get(
    "/ws",
    upgradeWebSocket(() => ({
      onOpen(_event, ws) {
        send(ws, {
          type: "hello",
          environmentId,
          version: VERSION,
          serverTime: new Date().toISOString(),
        });
      },
      onMessage(event, ws) {
        const frame = parseClientFrame(event.data);
        if (frame?.type === "ping") send(ws, { type: "pong", at: new Date().toISOString() });
      },
    })),
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

function send(ws: { send(data: string): void }, frame: ServerFrame): void {
  ws.send(JSON.stringify(frame));
}

function parseClientFrame(data: unknown): ClientFrame | null {
  if (typeof data !== "string") return null;
  try {
    const parsed = ClientFrame.safeParse(JSON.parse(data));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
