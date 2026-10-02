import { type ClientFrame, type EnvironmentId, ServerFrame } from "@tenzo/contracts";

export type ConnectionState = "closed" | "connecting" | "connected" | "reconnecting";

export interface ConnectionSnapshot {
  /**
   * `connected` means the daemon said hello, not merely that a socket opened: a daemon that
   * accepts and then drops (crash on hello, rejected token) must not look healthy.
   */
  state: ConnectionState;
  /** Consecutive failed attempts since the last hello. Drives the backoff. */
  attempt: number;
  /**
   * The last daemon that said hello. Kept across reconnects and after `close()` on purpose:
   * it is the "last known daemon", for showing cached state while offline.
   */
  environmentId: EnvironmentId | null;
  serverVersion: string | null;
}

export interface ConnectionOptions {
  url: string;
  /** Injectable for tests and non-browser hosts. Defaults to the global WebSocket. */
  WebSocket?: typeof WebSocket;
  /** First reconnect delay in ms. */
  minDelay?: number;
  /** Reconnect delay cap in ms. */
  maxDelay?: number;
  /** Returns a number in [0, 1]; drives jitter. */
  random?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
}

type Listener<T> = (value: T) => void;

/**
 * The one owner of the WebSocket to one daemon: connects, reconnects with capped
 * exponential backoff plus jitter, validates frames against the contracts, and
 * exposes a snapshot views can subscribe to. Framework-free.
 */
export class Connection {
  readonly #url: string;
  readonly #WebSocket: typeof WebSocket;
  readonly #minDelay: number;
  readonly #maxDelay: number;
  readonly #random: () => number;
  readonly #setTimeout: typeof setTimeout;
  readonly #clearTimeout: typeof clearTimeout;

  #socket: WebSocket | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #wanted = false;
  #snapshot: ConnectionSnapshot = {
    state: "closed",
    attempt: 0,
    environmentId: null,
    serverVersion: null,
  };
  readonly #listeners = new Set<Listener<ConnectionSnapshot>>();
  readonly #frameListeners = new Set<Listener<ServerFrame>>();

  constructor(options: ConnectionOptions) {
    this.#url = options.url;
    this.#WebSocket = options.WebSocket ?? globalThis.WebSocket;
    this.#minDelay = options.minDelay ?? 500;
    this.#maxDelay = options.maxDelay ?? 15_000;
    this.#random = options.random ?? Math.random;
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.#clearTimeout = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
  }

  get current(): ConnectionSnapshot {
    return this.#snapshot;
  }

  /** Calls `listener` now with the current snapshot and on every change. Returns an unsubscribe. */
  subscribe(listener: Listener<ConnectionSnapshot>): () => void {
    this.#listeners.add(listener);
    listener(this.#snapshot);
    return () => this.#listeners.delete(listener);
  }

  /** Receives every server frame that matches the contract. Returns an unsubscribe. */
  onFrame(listener: Listener<ServerFrame>): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  connect(): void {
    if (this.#wanted) return;
    this.#wanted = true;
    this.#update({ state: "connecting", attempt: 0 });
    this.#open();
  }

  /** Sends a frame if the socket is open. Returns whether it was sent. */
  send(frame: ClientFrame): boolean {
    const socket = this.#socket;
    if (!socket || socket.readyState !== this.#WebSocket.OPEN) return false;
    socket.send(JSON.stringify(frame));
    return true;
  }

  /** Closes the connection for good; no reconnects until `connect()` is called again. */
  close(): void {
    this.#wanted = false;
    if (this.#timer !== null) {
      this.#clearTimeout(this.#timer);
      this.#timer = null;
    }
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
      socket.close();
    }
    this.#update({ state: "closed", attempt: 0 });
  }

  #open(): void {
    let socket: WebSocket;
    try {
      socket = new this.#WebSocket(this.#url);
    } catch {
      // A bad URL or a mixed-content SecurityError throws instead of closing; retry the same way.
      this.#scheduleReconnect();
      return;
    }
    this.#socket = socket;
    // No onopen handler: the connection only counts once the daemon's hello arrives.
    socket.onmessage = (event: MessageEvent) => {
      if (socket !== this.#socket) return;
      this.#receive(event.data);
    };
    socket.onclose = () => {
      if (socket !== this.#socket) return;
      this.#socket = null;
      if (this.#wanted) this.#scheduleReconnect();
    };
    // An error is always followed by close; reconnect is handled there.
    socket.onerror = () => {};
  }

  #receive(data: unknown): void {
    if (typeof data !== "string") return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    const parsed = ServerFrame.safeParse(json);
    if (!parsed.success) return;
    const frame = parsed.data;
    if (frame.type === "hello") {
      this.#update({
        state: "connected",
        attempt: 0,
        environmentId: frame.environmentId,
        serverVersion: frame.version,
      });
    }
    for (const listener of this.#frameListeners) listener(frame);
  }

  #scheduleReconnect(): void {
    const attempt = this.#snapshot.attempt + 1;
    this.#update({ state: "reconnecting", attempt });
    this.#timer = this.#setTimeout(() => {
      this.#timer = null;
      if (this.#wanted) this.#open();
    }, this.#delay(attempt));
  }

  /** Capped exponential backoff with jitter in [50%, 100%] of the step. */
  #delay(attempt: number): number {
    const step = Math.min(this.#maxDelay, this.#minDelay * 2 ** (attempt - 1));
    return Math.round(step * (0.5 + 0.5 * this.#random()));
  }

  #update(patch: Partial<ConnectionSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch };
    for (const listener of this.#listeners) listener(this.#snapshot);
  }
}
