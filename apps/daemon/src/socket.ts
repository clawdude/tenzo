import {
  ClientFrame,
  type Command,
  type EnvironmentId,
  RequestFrameId,
  type ServerFrame,
} from "@tenzo/contracts";
import type { WSContext, WSEvents } from "hono/ws";
import type { WebSocket, WebSocketServer } from "ws";
import { executeCommand } from "./commands.ts";
import type { Engine, EngineChange } from "./engine.ts";
import { TenzoError } from "./errors.ts";

/**
 * The daemon's side of `/ws` (the protocol is in contracts' frames.ts). Each socket gets a hello
 * and a snapshot, then every thread, item and automations change the engine announces, in order; commands
 * run through `executeCommand`, as `POST /api/commands` does, and are answered by id.
 *
 * There is no replay: a client that loses its socket reconnects and gets a fresh snapshot, so a
 * socket that falls too far behind (a phone on a bad link) is simply dropped.
 */
export interface SocketOptions {
  environmentId: EnvironmentId;
  version: string;
  /** Without one, sockets get a hello and nothing else, and commands are refused. */
  engine?: Engine | undefined;
  log?: (message: string) => void;
}

/** More unsent bytes than this and the socket is dropped; the client re-snapshots. */
export const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;

/** Largest frame a client may send. Commands are small; this keeps garbage cheap. */
export const MAX_FRAME_BYTES = 1024 * 1024;

/** The most threads one socket watches at once: a screen watches one or two. */
export const MAX_WATCHED = 16;

/** Handlers for one socket, for Hono's `upgradeWebSocket`. */
export function socketHandlers({
  environmentId,
  version,
  engine,
  log = (message) => console.error(`tenzo: ${message}`),
}: SocketOptions): WSEvents {
  let unsubscribe: (() => void) | undefined;
  /** Threads this socket watches: it gets their new events (`thread.watch`). */
  const watching = new Set<string>();

  /**
   * Starts or stops a watch, answering at once. The backlog is read, the watch added and the
   * answer sent in one tick, before the engine can append anything: the client gets every event
   * after the backlog as an `event` frame, none of them twice.
   */
  function watch(id: string, command: WatchCommand): ServerFrame {
    if (command.type === "thread.unwatch") {
      watching.delete(command.threadId);
      return { type: "ok", id, result: { watching: false } };
    }
    if (!engine) return { type: "error", id, error: "This daemon runs no threads." };
    if (!watching.has(command.threadId) && watching.size >= MAX_WATCHED) {
      return {
        type: "error",
        id,
        error: `A connection can watch ${MAX_WATCHED} threads at most; unwatch one first.`,
      };
    }
    try {
      const backlog = engine.backlog(command.threadId, {
        ...(command.after !== undefined ? { after: command.after } : {}),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
      });
      // By the id the client gave, as unwatch and the cap check use it (ids are exact: the
      // backlog found this very thread).
      watching.add(command.threadId);
      return { type: "ok", id, result: backlog };
    } catch (error) {
      if (error instanceof TenzoError) return { type: "error", id, error: error.message };
      log(`thread.watch failed: ${String(error)}`);
      return { type: "error", id, error: `thread.watch failed: ${String(error)}` };
    }
  }

  return {
    onOpen(_event, ws) {
      send(ws, { type: "hello", environmentId, version, serverTime: new Date().toISOString() });
      if (!engine) return;
      // Snapshot and subscription in the same tick: the engine can't change in between, so the
      // client misses nothing and sees nothing twice.
      try {
        send(ws, { type: "snapshot", snapshot: engine.snapshot() });
      } catch (error) {
        log(`couldn't send a snapshot: ${String(error)}`);
        send(ws, { type: "error", id: null, error: `No snapshot: ${String(error)}` });
        ws.close(1011, "No snapshot");
        return;
      }
      unsubscribe = engine.subscribe((change) => {
        const frame = frameOf(change, watching);
        if (frame) send(ws, frame);
      });
    },
    onMessage(event, ws) {
      const frame = readFrame(event.data);
      if (!frame.ok) {
        log(`ignored a WebSocket frame: ${frame.error}`);
        send(ws, { type: "error", id: frame.id, error: frame.error });
        return;
      }
      if (frame.value.type === "ping") {
        send(ws, { type: "pong", at: new Date().toISOString() });
        return;
      }
      const { id, command } = frame.value;
      if (command.type === "thread.watch" || command.type === "thread.unwatch") {
        send(ws, watch(id, command));
        return;
      }
      void executeCommand(engine, command)
        .then((outcome) => {
          send(
            ws,
            outcome.ok
              ? { type: "ok", id, result: outcome.result }
              : { type: "error", id, error: outcome.error },
          );
        })
        // Sending the answer failed (a result that won't serialise, say): log it rather than
        // crash the daemon on an unhandled rejection. The client's command fails when the
        // socket does, or waits; it never gets a half-answer.
        .catch((error: unknown) => log(`couldn't answer command ${id}: ${String(error)}`));
    },
    onClose() {
      unsubscribe?.();
      unsubscribe = undefined;
      watching.clear();
    },
  };
}

type WatchCommand = Extract<Command, { type: "thread.watch" | "thread.unwatch" }>;

/**
 * What a client hears of an engine change. Raw events go only to sockets watching their thread;
 * the rest stay on the daemon (`thread.events`).
 */
function frameOf(change: EngineChange, watching: ReadonlySet<string>): ServerFrame | null {
  switch (change.type) {
    case "thread":
      return { type: "thread", thread: change.thread };
    case "item":
      return { type: "item", change: change.change.type, item: change.change.item };
    case "automations":
      return { type: "automations", ...change.automations };
    case "event": {
      if (!watching.has(change.event.threadId)) return null;
      const { seq, environmentId, event } = change;
      return { type: "event", event: { seq, environmentId, event } };
    }
  }
}

type Read =
  | { ok: true; value: ClientFrame }
  | { ok: false; id: string | null; error: string };

function readFrame(data: unknown): Read {
  if (typeof data !== "string") return { ok: false, id: null, error: "Frames are JSON text." };
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return { ok: false, id: null, error: "The frame is not JSON." };
  }
  const parsed = ClientFrame.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  // Answer a bad command by its id when it has one, so the client's request fails, not hangs.
  const raw = typeof json === "object" && json !== null ? (json as { id?: unknown }).id : undefined;
  const id = RequestFrameId.safeParse(raw);
  const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "frame"}: ${i.message}`);
  return { ok: false, id: id.success ? id.data : null, error: `Not a frame: ${issues.join("; ")}` };
}

function send(ws: WSContext, frame: ServerFrame): void {
  if (ws.readyState !== 1) return; // closing or closed: the client re-snapshots anyway
  ws.send(JSON.stringify(frame));
  const raw = ws.raw as Partial<Pick<WebSocket, "bufferedAmount" | "terminate">> | undefined;
  if ((raw?.bufferedAmount ?? 0) > MAX_BUFFERED_BYTES) raw?.terminate?.();
}

/**
 * Drops sockets whose other end has gone without closing (a phone that slept, a tailnet that
 * moved): every `intervalMs` each socket is pinged, and one that hasn't answered since the last
 * round is terminated. Returns a stop function.
 */
export function heartbeat(wss: WebSocketServer, intervalMs = 30_000): () => void {
  const alive = new WeakMap<WebSocket, boolean>();
  const markAlive = function (this: WebSocket) {
    alive.set(this, true);
  };
  wss.on("connection", (ws: WebSocket) => {
    alive.set(ws, true);
    ws.on("pong", markAlive);
    ws.on("message", markAlive);
  });
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
