import type { AddressInfo } from "node:net";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import type { EnvironmentId } from "@tenzo/contracts";
import { WebSocketServer } from "ws";
import { createApp } from "./app.ts";
import type { DaemonConfig } from "./config.ts";
import { loadEnvironmentId } from "./environment.ts";

export interface RunningDaemon {
  url: string;
  port: number;
  environmentId: EnvironmentId;
  /** Drops every WebSocket and stops listening. */
  close(): Promise<void>;
}

/** Loads the environment id and starts HTTP + WebSocket on the configured loopback port. */
export async function startDaemon(config: DaemonConfig): Promise<RunningDaemon> {
  const environmentId = loadEnvironmentId(config.home);
  const app = createApp({ environmentId, webDir: config.webDir });
  const wss = new WebSocketServer({ noServer: true });
  // ws types `noServer` as optional; Hono's adapter wants it present. It is, at runtime.
  const websocket = { server: wss as unknown as WebSocketServerLike };

  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const s = serve(
      { fetch: app.fetch, hostname: config.host, port: config.port, websocket },
      () => resolve(s),
    );
    s.once("error", reject);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://${config.host}:${port}`,
    port,
    environmentId,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const client of wss.clients) client.terminate();
        server.close((error) => (error ? reject(error) : resolve()));
        if ("closeAllConnections" in server) server.closeAllConnections();
      }),
  };
}
