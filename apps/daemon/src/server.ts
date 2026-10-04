import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
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
import { isLivePath, liveUpgrade } from "./live.ts";
import { heartbeat, MAX_FRAME_BYTES } from "./socket.ts";
import { openStore, type Store } from "./store.ts";
import { createClaudeTitler, type Titler } from "./titles.ts";

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
  /**
   * Names new threads (titles.ts). Default: a one-shot Claude, unless `adapters` is given (tests),
   * where threads then keep the prompt's first words: a test never spawns `claude` unasked.
   */
  titler?: Titler;
}

/**
 * Sends WebSocket upgrades under `/live/` to the thread's dev server (live.ts); every other
 * upgrade goes to Hono's `/ws` as before. One listener in front of Hono's: with two, Hono would
 * stop refusing the upgrades it doesn't take.
 */
function routeLiveUpgrades(
  server: ReturnType<typeof serve>,
  options: Parameters<typeof liveUpgrade>[3],
): void {
  const hono = server.listeners("upgrade") as ((...args: unknown[]) => void)[];
  server.removeAllListeners("upgrade");
  server.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (isLivePath(request.url)) return liveUpgrade(request, socket, head, options);
    for (const listener of hono) listener.call(server, request, socket, head);
  });
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
  const titler = deps.titler ?? (deps.adapters ? undefined : createClaudeTitler());
  const engine = new Engine({
    store,
    adapters: deps.adapters ?? { claude: createClaudeAdapter() },
    ...(titler ? { titler } : {}),
    ...(config.defaultModel ? { defaultModel: config.defaultModel } : {}),
  });
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
  routeLiveUpgrades(server, {
    policy: { allowedHosts: config.allowedHosts, devOrigins: config.devOrigins },
    portOf: (threadId) => engine.livePort(threadId),
  });
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
