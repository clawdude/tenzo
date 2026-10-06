import type { IncomingMessage } from "node:http";
import type { AddressInfo, Socket } from "node:net";
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
import { createLiveApp, type LiveTunnels, liveUpgrade } from "./live.ts";
import { loadVapidKeys, Push, type PushSend } from "./push.ts";
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
  /** Notifications to paired devices (push.ts). */
  push: Push;
  /**
   * Stops every agent session (open items stay for next time), drops every WebSocket (`/ws` and
   * live tunnels, both ends), gives requests in flight a moment, then cuts every connection left.
   */
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
  /** How often a paired device's socket gets a fresh Open live grant (auth.ts). Tests shorten it. */
  liveGrantRenewMs?: number;
  /** Posts Web Push messages (push.ts). Default: `fetch` to the push service. Tests pass fakes. */
  pushSend?: PushSend;
  /** How long a burst of cards on one thread waits to make one push (push.ts). Tests shorten it. */
  pushDebounceMs?: number;
  /** How long requests in flight get to finish when the daemon stops (`SHUTDOWN_GRACE_MS`). */
  shutdownGraceMs?: number;
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

type Listener = ReturnType<typeof serve>;

/** How long requests in flight get to finish when the daemon stops, before they are cut. */
const SHUTDOWN_GRACE_MS = 1000;

/**
 * Every connection a listener holds, upgraded ones included: once a socket is upgraded, Node's
 * own `closeAllConnections` no longer reaches it, and `close()` waits for it forever.
 */
function trackConnections(server: Listener): Set<Socket> {
  const open = new Set<Socket>();
  server.on("connection", (socket: Socket) => {
    open.add(socket);
    socket.once("close", () => open.delete(socket));
  });
  return open;
}

/**
 * Stops a listener: no new connections, idle kept-alive ones closed at once, requests in flight
 * given `graceMs` to finish, then every connection still open destroyed.
 */
function stopServer(
  server: Listener,
  connections: Set<Socket>,
  graceMs = SHUTDOWN_GRACE_MS,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const cut = setTimeout(() => {
      for (const socket of connections) socket.destroy();
    }, graceMs);
    server.close((error) => {
      clearTimeout(cut);
      if (error) reject(error);
      else resolve();
    });
    if ("closeIdleConnections" in server) server.closeIdleConnections();
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
  let pushKeys: ReturnType<typeof loadVapidKeys>;
  try {
    pushKeys = loadVapidKeys(store.home);
  } catch (error) {
    store.close();
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
  const devices = new Devices(store, {
    publicOrigin: config.publicUrl ?? null,
    allowedHosts: config.allowedHosts,
    liveOrigins: config.liveOrigins ?? [],
  });
  const push = new Push({
    devices,
    keys: pushKeys,
    ...(config.pushContact ? { contact: config.pushContact } : {}),
    ...(config.pushPreview ? { preview: config.pushPreview } : {}),
    ...(deps.pushSend ? { send: deps.pushSend } : {}),
    ...(deps.pushDebounceMs !== undefined ? { debounceMs: deps.pushDebounceMs } : {}),
  });
  const app = createApp({
    environmentId,
    webDir: config.webDir,
    engine,
    allowedHosts: config.allowedHosts,
    devOrigins: config.devOrigins,
    devices,
    liveGrantRenewMs: deps.liveGrantRenewMs,
    push,
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  // ws types `noServer` as optional; Hono's adapter wants it present. It is, at runtime.
  const websocket = { server: wss as unknown as WebSocketServerLike };

  let server: Listener;
  let liveServer: Listener;
  let connections: Set<Socket>;
  let liveConnections: Set<Socket>;
  const tunnels: LiveTunnels = new Set();
  let stopping = false;
  try {
    server = await listen(
      { fetch: app.fetch, hostname: config.host, port: config.port, websocket },
      `${config.host}:${config.port} is already in use; is tenzo already running? Set TENZO_PORT to use another port.`,
      () => wss.close(),
    );
    connections = trackConnections(server);
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
      liveConnections = trackConnections(liveServer);
    } catch (error) {
      wss.close();
      await stopServer(server, connections);
      throw error;
    }
    liveServer.on("upgrade", (request: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (stopping) socket.destroy();
      else liveUpgrade(request, socket, head, { policy, portOf, devices, tunnels });
    });
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
  push.start(engine);
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
    push,
    close: () => {
      closing ??= (async () => {
        stopping = true;
        // No new sockets from here on: ws refuses a `/ws` handshake once closing (503, no 101),
        // as the live listener's upgrade handler does (`stopping`).
        wss.close();
        stopHeartbeat();
        push.close();
        await engine.close();
        // Upgraded sockets first: `/ws` clients and both ends of every live app's tunnel (a
        // dev server's HMR socket). The listeners can't finish closing while one is open.
        for (const client of wss.clients) client.terminate();
        for (const end of tunnels) end.destroy();
        await Promise.all([
          stopServer(server, connections, deps.shutdownGraceMs),
          stopServer(liveServer, liveConnections, deps.shutdownGraceMs),
        ]);
        store.close();
        unlock();
      })();
      return closing;
    },
  };
}
