import { type ClientFrame, type EnvironmentId, ServerFrame } from "@tenzo/contracts";
import { consoleLog, type Log, notify } from "./notify.ts";

export type ConnectionState = "closed" | "connecting" | "connected" | "reconnecting";

export interface ConnectionSnapshot {
  /**
   * `connected` means the daemon said hello, not merely that a socket opened: a daemon that
   * accepts and then drops (crash on hello, rejected token) must not look healthy.
   */
  state: ConnectionState;
  /**
   * Consecutive failed attempts. Drives the backoff. Reset only once a connection has stayed up
   * for `stableAfter`, so a daemon that says hello and then drops still backs off.
   */
  attempt: number;
  /**
   * The last daemon that said hello. Kept across reconnects and after `close()` on purpose:
   * it is the "last known daemon", for showing cached state while offline.
   */
  environmentId: EnvironmentId | null;
  serverVersion: string | null;
  /**
   * The daemon's clock minus this device's, in ms, from the last hello (0 before one). Add it to
   * `Date.now()` to count down to a time the daemon set, such as a snooze's end: a phone's clock
   * can be minutes off the Mac's.
   */
  clockOffset: number;
  /**
   * A wakeup's probe is out: the connection looked up, but the page was away and the socket may
   * have died meanwhile. Until anything arrives on it, what it delivered may be stale.
   */
  probing: boolean;
}

/** A "look again now" moment. */
export interface Wakeup {
  /** How long the page was away (hidden, suspended) before this, in ms, when known. */
  away?: number;
}

/** Subscribes `wake` to whatever means "look again now"; returns an unsubscribe. */
export type WakeupSource = (wake: (wakeup?: Wakeup) => void) => () => void;

export interface ConnectionOptions {
  url: string;
  /** Injectable for tests and non-browser hosts. Defaults to the global WebSocket. */
  WebSocket?: typeof WebSocket;
  /** First reconnect delay in ms. */
  minDelay?: number;
  /** Reconnect delay cap in ms. */
  maxDelay?: number;
  /** How long a connection must stay up before the backoff starts over. */
  stableAfter?: number;
  /** How long an attempt may take, from opening the socket to the daemon's hello. */
  helloTimeout?: number;
  /** How long a healthy connection goes between pings. */
  pingInterval?: number;
  /** How long a ping may go unanswered before the connection counts as dead. */
  pongTimeout?: number;
  /** The same, for the ping sent on a wakeup: the person is looking, so decide fast. */
  probeTimeout?: number;
  /**
   * A page away at least this long gets a new socket at once when it comes back, without probing
   * the old one: a phone suspends sockets in the background, and by then the daemon's heartbeat
   * has dropped it anyway (after T3 Code's "long background suspension forces replacement").
   */
  replaceAfter?: number;
  /**
   * When to check the connection right away: the page became visible, the network came back.
   * Defaults to the browser's `visibilitychange`, `pageshow` and `online` events when there is a
   * document; null for none.
   */
  wakeups?: WakeupSource | null;
  /** Returns a number in [0, 1]; drives jitter. */
  random?: () => number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
  /** This device's clock, for `clockOffset`. Injectable for tests. */
  now?: () => number;
  /** Where a throwing listener or an invalid frame is reported. Default: the console. */
  log?: Log;
}

type Listener<T> = (value: T) => void;
type Timer = ReturnType<typeof setTimeout>;
/**
 * `retry`: until the next socket opens. `hello`: the deadline for the daemon's hello.
 * `liveness`: until the next ping, or after a ping the deadline for any frame at all.
 * `stable`: until the backoff resets.
 */
type TimerName = "retry" | "hello" | "liveness" | "stable";

/**
 * The one owner of the WebSocket to one daemon: connects, reconnects with capped exponential
 * backoff plus jitter, validates frames against the contracts, and notices a dead connection
 * (no hello in time, an unanswered ping, a socket a phone suspended without closing). Exposes a
 * snapshot views can subscribe to. Framework-free.
 */
export class Connection {
  readonly #url: string;
  readonly #WebSocket: typeof WebSocket;
  readonly #minDelay: number;
  readonly #maxDelay: number;
  readonly #stableAfter: number;
  readonly #helloTimeout: number;
  readonly #pingInterval: number;
  readonly #pongTimeout: number;
  readonly #probeTimeout: number;
  readonly #replaceAfter: number;
  readonly #wakeups: WakeupSource | null;
  readonly #random: () => number;
  readonly #setTimeout: typeof setTimeout;
  readonly #clearTimeout: typeof clearTimeout;
  readonly #log: Log;
  readonly #now: () => number;

  #socket: WebSocket | null = null;
  #wanted = false;
  #unwake: (() => void) | null = null;
  readonly #timers = new Map<TimerName, Timer>();
  /** A ping is out: the `liveness` timer is its deadline. */
  #awaitingPong = false;
  #snapshot: ConnectionSnapshot = {
    state: "closed",
    attempt: 0,
    environmentId: null,
    serverVersion: null,
    clockOffset: 0,
    probing: false,
  };
  readonly #listeners = new Set<Listener<ConnectionSnapshot>>();
  readonly #frameListeners = new Set<Listener<ServerFrame>>();

  constructor(options: ConnectionOptions) {
    this.#url = options.url;
    this.#WebSocket = options.WebSocket ?? globalThis.WebSocket;
    this.#minDelay = options.minDelay ?? 500;
    this.#maxDelay = options.maxDelay ?? 15_000;
    this.#stableAfter = options.stableAfter ?? 30_000;
    this.#helloTimeout = options.helloTimeout ?? 10_000;
    this.#pingInterval = options.pingInterval ?? 15_000;
    this.#pongTimeout = options.pongTimeout ?? 10_000;
    this.#probeTimeout = options.probeTimeout ?? 3_000;
    this.#replaceAfter = options.replaceAfter ?? 30_000;
    this.#wakeups =
      options.wakeups !== undefined
        ? options.wakeups
        : typeof document !== "undefined"
          ? browserWakeups
          : null;
    this.#random = options.random ?? Math.random;
    this.#setTimeout = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.#clearTimeout = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    this.#log = options.log ?? consoleLog;
    this.#now = options.now ?? Date.now;
  }

  get current(): ConnectionSnapshot {
    return this.#snapshot;
  }

  /** Calls `listener` now with the current snapshot and on every change. Returns an unsubscribe. */
  subscribe(listener: Listener<ConnectionSnapshot>): () => void {
    this.#listeners.add(listener);
    notify([listener], this.#snapshot, this.#log);
    return () => this.#listeners.delete(listener);
  }

  /** Receives every server frame that matches the contract, in order. Returns an unsubscribe. */
  onFrame(listener: Listener<ServerFrame>): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  connect(): void {
    if (this.#wanted) return;
    this.#wanted = true;
    this.#unwake = this.#wakeups?.((wakeup) => this.wake(wakeup)) ?? null;
    this.#update({ state: "connecting", attempt: 0 });
    // A listener may have called close() on hearing it.
    if (!this.#wanted) return;
    this.#open();
  }

  /**
   * "Look again now": the page came back to the foreground, or the network returned. A waiting
   * retry happens at once. A connection that looks up is replaced at once if the page was away
   * for `replaceAfter` or longer; otherwise it is pinged, `probing` while the ping is out, and
   * replaced at once if it doesn't answer within `probeTimeout` (a suspended phone's socket can
   * look open for minutes). An attempt in progress is left alone.
   */
  wake({ away = 0 }: Wakeup = {}): void {
    if (!this.#wanted) return;
    if (this.#timers.has("retry")) {
      this.#clear("retry");
      this.#open();
    } else if (this.#socket && this.#snapshot.state === "connected") {
      if (away >= this.#replaceAfter) {
        this.#lost({ immediately: true });
        return;
      }
      this.#ping(this.#probeTimeout, { immediately: true });
      this.#update({ probing: true });
    }
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
    this.#unwake?.();
    this.#unwake = null;
    this.#clear("retry");
    this.#drop();
    this.#update({ state: "closed", attempt: 0, probing: false });
  }

  #open(): void {
    let socket: WebSocket;
    try {
      socket = new this.#WebSocket(this.#url);
    } catch {
      // A bad URL or a mixed-content SecurityError throws instead of closing; retry the same way.
      this.#retry();
      return;
    }
    this.#socket = socket;
    this.#arm("hello", this.#helloTimeout, () => this.#lost());
    // No onopen handler: the connection only counts once the daemon's hello arrives.
    socket.onmessage = (event: MessageEvent) => {
      if (socket === this.#socket) this.#receive(event.data);
    };
    socket.onclose = () => {
      if (socket === this.#socket) this.#lost();
    };
    // An error is always followed by close; reconnect is handled there.
    socket.onerror = () => {};
  }

  #receive(data: unknown): void {
    // Anything at all from the daemon proves the connection is alive.
    if (this.#awaitingPong) this.#scheduleBeat();
    let json: unknown;
    try {
      json = typeof data === "string" ? JSON.parse(data) : undefined;
    } catch {
      // reported below, as not matching
    }
    const parsed = ServerFrame.safeParse(json);
    if (!parsed.success) {
      this.#log("ignored a frame that doesn't match the contract", parsed.error.issues);
      return;
    }
    const frame = parsed.data;
    if (frame.type === "hello") {
      this.#clear("hello");
      this.#arm("stable", this.#stableAfter, () => this.#update({ attempt: 0 }));
      this.#scheduleBeat();
      const serverTime = Date.parse(frame.serverTime);
      this.#update({
        state: "connected",
        environmentId: frame.environmentId,
        serverVersion: frame.version,
        // The hello's few ms in flight don't matter for a countdown in minutes.
        clockOffset: Number.isFinite(serverTime) ? serverTime - this.#now() : 0,
      });
    }
    notify(this.#frameListeners, frame, this.#log);
    // The probe is answered: the connection was alive, so everything it delivered still holds.
    if (this.#snapshot.probing && this.#socket) this.#update({ probing: false });
  }

  /** Waits `pingInterval`, then pings. */
  #scheduleBeat(): void {
    this.#arm("liveness", this.#pingInterval, () => this.#ping(this.#pongTimeout));
  }

  /** Pings, and gives the daemon `timeout` to say anything at all before giving up on it. */
  #ping(timeout: number, { immediately = false } = {}): void {
    this.#arm("liveness", timeout, () => this.#lost({ immediately }));
    this.#awaitingPong = true;
    this.send({ type: "ping", at: new Date().toISOString() });
  }

  /** The current socket is gone or useless: drop it and, if still wanted, try again. */
  #lost({ immediately = false } = {}): void {
    this.#drop();
    if (this.#wanted) this.#retry({ immediately });
  }

  #drop(): void {
    this.#clear("hello");
    this.#clear("liveness");
    this.#clear("stable");
    const socket = this.#socket;
    this.#socket = null;
    if (!socket) return;
    socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
    try {
      socket.close();
    } catch {
      // closing already
    }
  }

  #retry({ immediately = false } = {}): void {
    const attempt = this.#snapshot.attempt + 1;
    this.#update({ state: "reconnecting", attempt, probing: false });
    // A listener may have called close() on hearing it: then nothing must reopen a socket.
    if (!this.#wanted) return;
    if (immediately) this.#open();
    else this.#arm("retry", this.#delay(attempt), () => this.#open());
  }

  /** Capped exponential backoff with jitter in [50%, 100%] of the step. */
  #delay(attempt: number): number {
    const step = Math.min(this.#maxDelay, this.#minDelay * 2 ** (attempt - 1));
    return Math.round(step * (0.5 + 0.5 * this.#random()));
  }

  /** Runs `fn` after `ms`, replacing the timer of that name. */
  #arm(name: TimerName, ms: number, fn: () => void): void {
    this.#clear(name);
    const timer = this.#setTimeout(() => {
      this.#timers.delete(name);
      if (name === "liveness") this.#awaitingPong = false;
      fn();
    }, ms);
    this.#timers.set(name, timer);
  }

  #clear(name: TimerName): void {
    const timer = this.#timers.get(name);
    if (timer !== undefined) this.#clearTimeout(timer);
    this.#timers.delete(name);
    if (name === "liveness") this.#awaitingPong = false;
  }

  #update(patch: Partial<ConnectionSnapshot>): void {
    const snapshot = { ...this.#snapshot, ...patch };
    this.#snapshot = snapshot;
    notify(this.#listeners, snapshot, this.#log, () => this.#snapshot === snapshot);
  }
}

/** The parts of a page `pageWakeups` listens to. */
export interface PageEvents {
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  window: Pick<EventTarget, "addEventListener" | "removeEventListener">;
  now: () => number;
}

/**
 * A page's "look again" moments: it is shown again (saying how long it was hidden), restored
 * from the back-forward cache (away for an unknown time, so treated as long), or back online.
 */
export function pageWakeups(page: PageEvents): WakeupSource {
  return (wake) => {
    let hiddenAt: number | null = page.document.visibilityState === "hidden" ? page.now() : null;
    const onVisibility = () => {
      if (page.document.visibilityState === "hidden") {
        hiddenAt ??= page.now();
        return;
      }
      const away = hiddenAt === null ? 0 : page.now() - hiddenAt;
      hiddenAt = null;
      wake({ away });
    };
    const onPageShow = (event: Event) => {
      wake((event as PageTransitionEvent).persisted ? { away: Number.POSITIVE_INFINITY } : {});
    };
    const onOnline = () => wake();
    page.document.addEventListener("visibilitychange", onVisibility);
    page.window.addEventListener("pageshow", onPageShow);
    page.window.addEventListener("online", onOnline);
    return () => {
      page.document.removeEventListener("visibilitychange", onVisibility);
      page.window.removeEventListener("pageshow", onPageShow);
      page.window.removeEventListener("online", onOnline);
    };
  };
}

/** The browser's "look again" moments (`pageWakeups` on this page). */
export const browserWakeups: WakeupSource = (wake) =>
  pageWakeups({ document, window: globalThis, now: Date.now })(wake);
