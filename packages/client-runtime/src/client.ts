import {
  type Command,
  type CommandResult,
  CommandResults,
  type CommandType,
  type ServerFrame,
} from "@tenzo/contracts";
import { Connection, type ConnectionOptions, type ConnectionSnapshot } from "./connection.ts";
import { consoleLog, type Log, notify } from "./notify.ts";
import { applyFrame, type Data, EMPTY } from "./state.ts";

/** Everything a view reads: the connection, and the daemon's threads and open items. */
export interface TenzoState extends Data {
  connection: ConnectionSnapshot;
  /**
   * The data is the daemon's as of now: this connection's snapshot has arrived. False while
   * connecting or reconnecting, when `threads` and `items` are the last known ones (or empty).
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
  #nextId = 1;
  #state: TenzoState;

  constructor(options: ConnectionOptions) {
    this.#log = options.log ?? consoleLog;
    this.connection = new Connection(options);
    this.#state = { ...EMPTY, connection: this.connection.current, synced: false };
    this.connection.onFrame((frame) => this.#receive(frame));
    this.connection.subscribe((connection) => {
      if (connection.state !== "connected") this.#disconnected();
      this.#set({ connection, synced: connection.state === "connected" && this.#state.synced });
    });
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
    if (this.connection.current.state !== "connected") {
      return Promise.reject(
        new CommandError("offline", "Not connected to Tenzo. Try again once it's back."),
      );
    }
    const id = String(this.#nextId++);
    return new Promise((resolve, reject) => {
      if (!this.connection.send({ type: "command", id, command })) {
        reject(new CommandError("offline", "Not connected to Tenzo. Try again once it's back."));
        return;
      }
      this.#pending.set(id, {
        type: command.type,
        resolve: resolve as (result: unknown) => void,
        reject,
      });
    });
  }

  #receive(frame: ServerFrame): void {
    switch (frame.type) {
      case "snapshot":
        this.#set({ ...applyFrame(this.#state, frame), synced: true });
        return;
      case "thread":
      case "item":
        this.#set(applyFrame(this.#state, frame));
        return;
      case "ok": {
        const pending = this.#take(frame.id);
        if (!pending) return;
        const result = CommandResults[pending.type].safeParse(frame.result);
        if (result.success) pending.resolve(result.data);
        else {
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
      next.items === this.#state.items
    ) {
      return;
    }
    this.#state = next;
    notify(this.#listeners, this.#state, this.#log);
  }
}
