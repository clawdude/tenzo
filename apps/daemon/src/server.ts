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
import { Devices } from "./devices.ts";
import { Engine } from "./engine.ts";
import { TenzoError } from "./errors.ts";
import { lockHome } from "./home.ts";
import { createLiveApp, liveUpgrade } from "./live.ts";
import { heartbeat, MAX_FRAME_BYTES } from "./socket.ts";
import { openStore, type Store } from "./store.ts";
import { createClaudeTitler, type Titler } from "./titles.ts";

export interface RunningDaemon {
  url: string;
  port: number;
  /** The live listener's port: threads' live apps (live.ts). */
  livePort: number;
  environmentId: EnvironmentId;
  engine: Engine;
  /** Paired devices: pairing codes, tokens, revocation (devices.ts). */
  devices: Devices;
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

/** Starts listening, with a plain message when the port is taken. */
function listen(
  options: Parameters<typeof serve>[0],
  taken: string,
  onError: () => void = () => {},
): Promise<ReturnType<typeof serve>> {
  return new Promise((resolve, reject) => {
    const onListenError = (error: NodeJS.ErrnoException) => {
      onError();
      reject(error.code === "EADDRINUSE" ? new TenzoError(taken) : error);
    };
    const s = serve(options, () => {
      s.off("error", onListenError);
      // After listening, errors are per-connection trouble: log them, keep serving.
      s.on("error", (error) => console.error("tenzo: server error:", error));
      resolve(s);
    });
    s.once("error", onListenError);
  });
}

/** Stops a server and drops its open connections. */
function stopServer(server: ReturnType<typeof serve>): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    if ("closeAllConnections" in server) server.closeAllConnections();
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
    ...(config.snoozeMs ? { snoozeMs: config.snoozeMs } : {}),
  });
  const environmentId = store.environmentId;
  const devices = new Devices(store);
  const app = createApp({
    environmentId,
    webDir: config.webDir,
    engine,
    allowedHosts: config.allowedHosts,
    devOrigins: config.devOrigins,
    devices,
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  // ws types `noServer` as optional; Hono's adapter wants it present. It is, at runtime.
  const websocket = { server: wss as unknown as WebSocketServerLike };

  let server: ReturnType<typeof serve>;
  let liveServer: ReturnType<typeof serve>;
  try {
    server = await listen(
      { fetch: app.fetch, hostname: config.host, port: config.port, websocket },
      `${config.host}:${config.port} is already in use; is tenzo already running? Set TENZO_PORT to use another port.`,
      () => wss.close(),
    );
    // Threads' live apps, on an origin of their own (live.ts).
    const livePort = config.livePort ?? (config.port === 0 ? 0 : config.port + 1);
    const liveOrigins = config.liveOrigins ?? [];
    const policy = {
      allowedHosts: [...config.allowedHosts, ...liveOrigins.map((o) => new URL(o).hostname)],
    };
    const portOf = (threadId: string) => engine.livePort(threadId);
    try {
      liveServer = await listen(
        { fetch: createLiveApp({ policy, portOf, devices }).fetch, hostname: config.host, port: livePort },
        `${config.host}:${livePort} (threads' live apps) is already in use. Set TENZO_LIVE_PORT to use another port.`,
      );
    } catch (error) {
      wss.close();
      await stopServer(server);
      throw error;
    }
    liveServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) =>
      liveUpgrade(request, socket, head, { policy, portOf, devices }),
    );
    engine.setLive({
      port: (liveServer.address() as AddressInfo).port,
      origins: liveOrigins,
      grant: null,
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
    livePort: (liveServer.address() as AddressInfo).port,
    environmentId,
    engine,
    devices,
    close: () => {
      closing ??= (async () => {
        stopHeartbeat();
        await engine.close();
        for (const client of wss.clients) client.terminate();
        await Promise.all([stopServer(server), stopServer(liveServer)]);
        store.close();
        unlock();
      })();
      return closing;
    },
  };
}
