import {
  type Command,
  type CommandResult,
  CommandResults,
  type CommandType,
  type ServerFrame,
} from "@tenzo/contracts";
import { Connection, type ConnectionOptions, type ConnectionSnapshot } from "./connection.ts";
import {
  appendLive,
  applyBacklog,
  emptyFeed,
  type Feed,
  lastSeqOf,
  OLDER_PAGE,
  prependOlder,
} from "./feed.ts";
import { consoleLog, type Log, notify } from "./notify.ts";
import { applyFrame, type Data, EMPTY } from "./state.ts";

/** Everything a view reads: the connection, and the daemon's threads and open items. */
export interface TenzoState extends Data {
  connection: ConnectionSnapshot;
  /**
   * The data is the daemon's as of now: this connection's snapshot has arrived and the connection
   * is known to be alive. False while connecting or reconnecting, when `threads` and `items` are
   * the last known ones (or empty), and while a wakeup's probe is out (`connection.probing`).
   */
  synced: boolean;
}

/**
 * Why a command failed. `offline`: not connected, so it was never sent. `lost`: the connection
 * dropped after sending, so it may or may not have run. `rejected`: the daemon said no, and
 * `message` says why. `invalid`: the daemon's answer didn't match the contract.
 */
export class CommandError extends Error {
  override name = "CommandError";
  readonly reason: "offline" | "lost" | "rejected" | "invalid";
  constructor(reason: CommandError["reason"], message: string) {
    super(message);
    this.reason = reason;
  }
}

interface Pending {
  type: CommandType;
  resolve: (result: unknown) => void;
  reject: (error: CommandError) => void;
}

interface Watched {
  feed: Feed;
  listeners: Set<(feed: Feed) => void>;
  /** A `thread.watch` is out: live events wait for its backlog. */
  pending: boolean;
}

/**
 * A client of one daemon: owns the connection, keeps an in-memory copy of the daemon's threads
 * and open items up to date from its frames, and sends commands over the same socket. Every
 * (re)connect brings a fresh snapshot that replaces the data, so nothing needs a reload.
 *
 * Commands are not queued while offline: they fail at once with `offline`, and the view decides
 * whether to try again. An answer sent twice could answer the wrong card, so retrying is never
 * this layer's call.
 */
export class TenzoClient {
  readonly connection: Connection;
  readonly #log: Log;
  readonly #listeners = new Set<(state: TenzoState) => void>();
  readonly #pending = new Map<string, Pending>();
  /** Threads being watched, each with its feed and listeners. */
  readonly #feeds = new Map<string, Watched>();
  #nextId = 1;
  /** This connection's snapshot has arrived. */
  #snapshotted = false;
  #state: TenzoState;

  constructor(options: ConnectionOptions) {
    this.#log = options.log ?? consoleLog;
    this.connection = new Connection(options);
    this.#state = { ...EMPTY, connection: this.connection.current, synced: false };
    this.connection.onFrame((frame) => this.#receive(frame));
    this.connection.subscribe((connection) => {
      if (connection.state !== "connected") {
        this.#snapshotted = false;
        this.#disconnected();
      }
      this.#set({ connection, synced: this.#synced(connection) });
    });
  }

  #synced(connection: ConnectionSnapshot): boolean {
    return this.#snapshotted && connection.state === "connected" && !connection.probing;
  }

  get state(): TenzoState {
    return this.#state;
  }

  /** Calls `listener` now and after every change. Returns an unsubscribe. */
  subscribe(listener: (state: TenzoState) => void): () => void {
    this.#listeners.add(listener);
    notify([listener], this.#state, this.#log);
    return () => this.#listeners.delete(listener);
  }

  connect(): void {
    this.connection.connect();
  }

  close(): void {
    this.connection.close();
  }

  /**
   * Runs a command on the daemon. Resolves with its result, validated against the contract,
   * after the changes it caused have reached `state`. Rejects with a `CommandError`.
   */
  command<C extends Command>(command: C): Promise<CommandResult<C["type"]>> {
    return new Promise((resolve, reject) => {
      this.#request(command, resolve as (result: unknown) => void, reject);
    });
  }

  /**
   * Sends a command and calls back as its answer arrives, in the same tick as the frame: a
   * watch's backlog must be in its feed before the next frame (its first live event) is read.
   */
  #request(command: Command, resolve: (result: unknown) => void, reject: (e: CommandError) => void) {
    const id = String(this.#nextId++);
    if (
      this.connection.current.state !== "connected" ||
      !this.connection.send({ type: "command", id, command })
    ) {
      reject(new CommandError("offline", "Not connected to Tenzo. Try again once it's back."));
      return;
    }
    this.#pending.set(id, { type: command.type, resolve, reject });
  }

  /**
   * Follows one thread's events: `listener` gets the thread's feed now and on every change (the
   * backlog arriving, each new event, older pages, the connection dropping). Several listeners
   * share one watch. A reconnect watches again from the last event held, so nothing is missed.
   * Returns the unwatch; the daemon stops sending once the last listener has gone.
   */
  watch(threadId: string, listener: (feed: Feed) => void): () => void {
    let watched = this.#feeds.get(threadId);
    if (!watched) {
      watched = { feed: emptyFeed(threadId), listeners: new Set(), pending: false };
      this.#feeds.set(threadId, watched);
      if (this.#snapshotted) this.#sendWatch(threadId);
      else watched.feed = { ...watched.feed, status: this.#offlineStatus() };
    }
    const entry = watched;
    entry.listeners.add(listener);
    notify([listener], entry.feed, this.#log);
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size > 0 || this.#feeds.get(threadId) !== entry) return;
      this.#feeds.delete(threadId);
      if (this.#snapshotted) {
        this.#request({ type: "thread.unwatch", threadId }, () => {}, () => {});
      }
    };
  }

  /** The feed of a watched thread, as it is now. */
  feed(threadId: string): Feed | undefined {
    return this.#feeds.get(threadId)?.feed;
  }

  /** Pages a watched thread's earlier events into its feed (`Feed.older`). */
  loadOlder(threadId: string): Promise<void> {
    const entry = this.#feeds.get(threadId);
    const first = entry?.feed.events[0]?.seq;
    if (!entry || first === undefined || !entry.feed.older || entry.feed.loadingOlder) {
      return Promise.resolve();
    }
    this.#setFeed(entry, { ...entry.feed, loadingOlder: true });
    return this.command({ type: "thread.events", threadId, before: first, limit: OLDER_PAGE }).then(
      (page) => {
        if (this.#feeds.get(threadId) === entry) {
          this.#setFeed(entry, prependOlder(entry.feed, page.events, page.older));
        }
      },
      (error: unknown) => {
        if (this.#feeds.get(threadId) === entry) {
          this.#setFeed(entry, { ...entry.feed, loadingOlder: false });
        }
        throw error;
      },
    );
  }

  #offlineStatus(): Feed["status"] {
    return this.connection.current.state === "closed" ? "offline" : "loading";
  }

  #sendWatch(threadId: string): void {
    const entry = this.#feeds.get(threadId);
    if (!entry) return;
    entry.pending = true;
    const after = lastSeqOf(entry.feed);
    this.#request(
      { type: "thread.watch", threadId, ...(after !== undefined ? { after } : {}) },
      (result) => {
        if (this.#feeds.get(threadId) !== entry) return; // unwatched meanwhile
        entry.pending = false;
        this.#setFeed(entry, applyBacklog(entry.feed, result as CommandResult<"thread.watch">));
      },
      (error) => {
        if (this.#feeds.get(threadId) !== entry) return;
        entry.pending = false;
        // Dropped or not sent: the next connection watches again. Refused: say why.
        this.#setFeed(
          entry,
          error.reason === "rejected" || error.reason === "invalid"
            ? { ...entry.feed, status: "failed", error: error.message }
            : { ...entry.feed, status: "offline" },
        );
      },
    );
  }

  #setFeed(entry: Watched, feed: Feed): void {
    if (feed === entry.feed) return;
    entry.feed = feed;
    notify(entry.listeners, feed, this.#log, () => entry.feed === feed);
  }

  #receive(frame: ServerFrame): void {
    switch (frame.type) {
      case "snapshot":
        this.#snapshotted = true;
        this.#set({
          ...applyFrame(this.#state, frame),
          synced: this.#synced(this.connection.current),
        });
        // A new connection: it watches nothing yet, so watch again what this client follows.
        for (const threadId of this.#feeds.keys()) this.#sendWatch(threadId);
        return;
      case "event": {
        const entry = this.#feeds.get(frame.event.event.threadId);
        // While a watch's answer is on its way, its backlog has everything sent before it.
        if (!entry || entry.pending) return;
        this.#setFeed(entry, appendLive(entry.feed, frame.event));
        return;
      }
      case "thread":
      case "item":
        this.#set(applyFrame(this.#state, frame));
        return;
      case "ok": {
        const pending = this.#take(frame.id);
        if (!pending) return;
        const result = CommandResults[pending.type].safeParse(frame.result);
        if (result.success) {
          // Projects change outside the daemon (`tenzo project add`), so no frame says so: a
          // fresh list is news for everyone reading `state`.
          if (pending.type === "project.list") {
            this.#set({ projects: (result.data as CommandResult<"project.list">).projects });
          }
          pending.resolve(result.data);
        } else {
          this.#log(`the answer to ${pending.type} doesn't match the contract`, result.error.issues);
          pending.reject(
            new CommandError("invalid", `Tenzo's answer to ${pending.type} didn't make sense.`),
          );
        }
        return;
      }
      case "error": {
        const pending = frame.id === null ? undefined : this.#take(frame.id);
        if (pending) pending.reject(new CommandError("rejected", frame.error));
        else this.#log("the daemon reported an error", frame.error);
        return;
      }
    }
  }

  #take(id: string): Pending | undefined {
    const pending = this.#pending.get(id);
    this.#pending.delete(id);
    return pending;
  }

  /** The socket is gone: whatever was sent on it will never be answered on it. */
  #disconnected(): void {
    for (const entry of this.#feeds.values()) {
      entry.pending = false;
      if (entry.feed.status !== "offline") this.#setFeed(entry, { ...entry.feed, status: "offline" });
    }
    const pending = [...this.#pending.values()];
    this.#pending.clear();
    for (const p of pending) {
      p.reject(
        new CommandError(
          "lost",
          "The connection to Tenzo dropped before it answered; the command may or may not have run.",
        ),
      );
    }
  }

  #set(patch: Partial<TenzoState>): void {
    const next = { ...this.#state, ...patch };
    if (
      next.connection === this.#state.connection &&
      next.synced === this.#state.synced &&
      next.threads === this.#state.threads &&
      next.items === this.#state.items &&
      next.projects === this.#state.projects
    ) {
      return;
    }
    this.#state = next;
    notify(this.#listeners, next, this.#log, () => this.#state === next);
  }
}
