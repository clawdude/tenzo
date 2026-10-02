import type { AddressInfo } from "node:net";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import type { EnvironmentId } from "@tenzo/contracts";
import { WebSocketServer } from "ws";
import { createApp } from "./app.ts";
import type { DaemonConfig } from "./config.ts";
import { loadEnvironmentId } from "./environment.ts";
import { TenzoError } from "./errors.ts";

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
    const onListenError = (error: NodeJS.ErrnoException) => {
      wss.close();
      reject(
        error.code === "EADDRINUSE"
          ? new TenzoError(
              `${config.host}:${config.port} is already in use; is tenzo already running? Set TENZO_PORT to use another port.`,
            )
          : error,
      );
    };
    const s = serve(
      { fetch: app.fetch, hostname: config.host, port: config.port, websocket },
      () => {
        s.off("error", onListenError);
        // After listening, errors are per-connection trouble: log them, keep serving.
        s.on("error", (error) => console.error("tenzo: server error:", error));
        resolve(s);
      },
    );
    s.once("error", onListenError);
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
