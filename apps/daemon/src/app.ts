import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { upgradeWebSocket } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { ClientFrame, type EnvironmentId, type Health, type ServerFrame } from "@tenzo/contracts";
import { Hono } from "hono";
import pkg from "../package.json" with { type: "json" };

export const VERSION: string = pkg.version;

export interface AppOptions {
  environmentId: EnvironmentId;
  /** The built web app. Served from the same origin so Tailscale Serve needs one proxy. */
  webDir: string;
}

/**
 * The daemon's HTTP surface: `/health`, the `/ws` WebSocket, and the web app with an SPA
 * fallback. The WebSocket only upgrades when served by `startDaemon` (it needs the Node server).
 */
export function createApp({ environmentId, webDir }: AppOptions): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, version: VERSION, environmentId } satisfies Health));

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
  app.use("*", async (c, next) => {
    const immutable = c.req.path.startsWith("/_app/immutable/");
    c.header("Cache-Control", immutable ? "public, max-age=31536000, immutable" : "no-cache");
    await next();
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
