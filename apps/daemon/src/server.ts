import type { AddressInfo } from "node:net";
import { serve, type WebSocketServerLike } from "@hono/node-server";
import type { EnvironmentId } from "@tenzo/contracts";
import { WebSocketServer } from "ws";
import type { AgentAdapter } from "./agent/agent.ts";
import { createClaudeAdapter } from "./agent/claude.ts";
import { createApp } from "./app.ts";
import type { DaemonConfig } from "./config.ts";
import { Engine } from "./engine.ts";
import { TenzoError } from "./errors.ts";
import { lockHome } from "./home.ts";
import { heartbeat, MAX_FRAME_BYTES } from "./socket.ts";
import { openStore, type Store } from "./store.ts";

export interface RunningDaemon {
  url: string;
  port: number;
  environmentId: EnvironmentId;
  engine: Engine;
  /** Stops every agent session (open items stay for next time), drops every WebSocket, stops listening. */
  close(): Promise<void>;
}

export interface DaemonDeps {
  /** The agents threads run. Default: Claude Code. Tests pass fakes. */
  adapters?: Partial<Record<"claude" | "codex", AgentAdapter>>;
  /** How often silent WebSockets are pinged, and dropped if still silent next time (socket.ts). */
  heartbeatMs?: number;
}

/**
 * Opens Tenzo's store, picks up the threads where the last daemon left them, and serves HTTP +
 * WebSocket on the configured loopback port.
 */
export async function startDaemon(
  config: DaemonConfig,
  deps: DaemonDeps = {},
): Promise<RunningDaemon> {
  const unlock = lockHome(config.home);
  let store: Store;
  try {
    store = openStore(config.home);
  } catch (error) {
    unlock();
    throw error;
  }
  const engine = new Engine({ store, adapters: deps.adapters ?? { claude: createClaudeAdapter() } });
  const environmentId = store.environmentId;
  const app = createApp({
    environmentId,
    webDir: config.webDir,
    engine,
    allowedHosts: config.allowedHosts,
    devOrigins: config.devOrigins,
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  // ws types `noServer` as optional; Hono's adapter wants it present. It is, at runtime.
  const websocket = { server: wss as unknown as WebSocketServerLike };

  let server: ReturnType<typeof serve>;
  try {
    server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
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
  } catch (error) {
    store.close();
    unlock();
    throw error;
  }
  engine.start();
  const stopHeartbeat = heartbeat(wss, deps.heartbeatMs);
  const { port } = server.address() as AddressInfo;

  let closing: Promise<void> | undefined;
  return {
    url: `http://${config.host}:${port}`,
    port,
    environmentId,
    engine,
    close: () => {
      closing ??= (async () => {
        stopHeartbeat();
        await engine.close();
        await new Promise<void>((resolve, reject) => {
          for (const client of wss.clients) client.terminate();
          server.close((error) => (error ? reject(error) : resolve()));
          if ("closeAllConnections" in server) server.closeAllConnections();
        });
        store.close();
        unlock();
      })();
      return closing;
    },
  };
}
