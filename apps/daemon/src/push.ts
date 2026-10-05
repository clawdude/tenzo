import { chmodSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PushMessage, QueueItem, QueueItemId, ThreadId } from "@tenzo/contracts";
import webpush from "web-push";
import type { Devices, PushTarget } from "./devices.ts";
import type { EngineChange } from "./engine.ts";
import { TenzoError } from "./errors.ts";

/**
 * Web Push (PRODUCT.md §9): a paired phone hears about a card even when Tenzo isn't open on it.
 * No cloud of ours: the daemon signs each message with its own VAPID key and posts it, encrypted
 * to the browser's key, to that browser's push service (Apple's, Google's, Mozilla's). That is
 * the only outbound connection it needs.
 *
 * What pushes: a quick-lane card (a question, a permission, a proposal, an error or budget
 * pause, a PR ready to merge) that opened or came back from a snooze, never finished work (the
 * review lane) and never a card already answered. One notification per thread: its tag is the
 * thread's id, so a newer card replaces it, and a burst of cards within `DEBOUNCE_MS` makes one
 * push. Not to a muted device, nor to one that has Tenzo open and in view right now: it sees the
 * card.
 *
 * Nothing here can hold the engine up: changes are noted synchronously and sent later; a push
 * service that fails is retried with backoff, one that says the subscription is gone (404, 410)
 * gets it forgotten.
 */

/** Cards that arrive within this long of each other on a thread make one push. */
export const DEBOUNCE_MS = 3_000;

/** Waits before trying a push again after a 5xx, a 429 or no answer at all. */
export const RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;

/** The longest a push service's Retry-After is honoured. */
const MAX_RETRY_AFTER_MS = 10 * 60_000;

/** How long a push service keeps an undelivered message (a phone that is off): an hour. */
export const PUSH_TTL_S = 60 * 60;

/** How long one push request may take. */
const SEND_TIMEOUT_MS = 15_000;

/**
 * A page says it is in view, but a phone can freeze it without a word: it counts as in view only
 * while its socket keeps talking (the client pings every 15 s).
 */
export const VISIBLE_FRESH_MS = 45_000;

/** How much a notification says (`TENZO_PUSH_PREVIEW`): the thread and a short line, or nothing. */
export type PushPreview = "short" | "none";

/** The VAPID contact (`sub`) when `TENZO_PUSH_CONTACT` doesn't name one: who sends these. */
export const DEFAULT_PUSH_CONTACT = "https://github.com/clawdude/tenzo";

// Keys.

export interface VapidKeys {
  /** base64url, uncompressed P-256 point: what browsers subscribe with (`applicationServerKey`). */
  publicKey: string;
  /** base64url, 32 bytes. Never leaves the Mac. */
  privateKey: string;
}

/** Where the daemon's VAPID keys live: `$TENZO_HOME/push-keys.json`, readable only by you. */
export function vapidKeysPath(home: string): string {
  return join(home, "push-keys.json");
}

/**
 * The daemon's VAPID keys: made once, kept under `home` (0600). Every subscription is made with
 * the public key, so new keys would orphan them all: an unreadable file is an error that says
 * what to do, never silently replaced.
 */
export function loadVapidKeys(home: string): VapidKeys {
  const path = vapidKeysPath(home);
  const fresh = webpush.generateVAPIDKeys();
  try {
    // `wx`: only if there is none yet. Two daemons can't race here (lockHome), but a crash can't
    // leave half a file behind either: the write is one call on a new file.
    writeFileSync(
      path,
      `${JSON.stringify({ publicKey: fresh.publicKey, privateKey: fresh.privateKey })}\n`,
      { mode: 0o600, flag: "wx" },
    );
    return { publicKey: fresh.publicKey, privateKey: fresh.privateKey };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  // Kept private even if something loosened it.
  if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
  let keys: unknown;
  try {
    keys = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    keys = null;
  }
  const { publicKey, privateKey } = (keys ?? {}) as Partial<VapidKeys>;
  if (
    typeof publicKey !== "string" ||
    typeof privateKey !== "string" ||
    !/^[A-Za-z0-9_-]{86,88}$/.test(publicKey) ||
    !/^[A-Za-z0-9_-]{42,44}$/.test(privateKey)
  ) {
    throw new TenzoError(
      `${path} doesn't hold Tenzo's push keys. Delete it to make new ones; every device then turns its notifications on again (Devices).`,
    );
  }
  return { publicKey, privateKey };
}

// What a push says.

/** True for a card that may push: open, awake, quick lane. Never finished work. */
export function pushes(item: QueueItem): boolean {
  return (
    item.status === "open" &&
    item.lane === "quick" &&
    item.kind !== "finished" &&
    item.snoozedUntil === null
  );
}

/**
 * The notification for a card: the thread's name and one short line, or with `preview` "none"
 * nothing but that a thread needs you. Never a permission's command line, never context: the
 * message passes through the push service (encrypted, but still).
 */
export function pushMessageOf(item: QueueItem, threadTitle: string, preview: PushPreview): PushMessage {
  const base = { tag: item.threadId, url: `/?item=${item.id}` };
  if (preview === "none") return { ...base, title: "Tenzo", body: "A thread needs you." };
  return { ...base, title: clip(threadTitle, 60) || "Tenzo", body: clip(lineOf(item), 120) };
}

function lineOf(item: QueueItem): string {
  switch (item.kind) {
    case "permission":
      // The tool's name only: its input (a command, a URL) can carry anything.
      return item.permission ? `Allow ${clip(item.permission.toolName, 40)}?` : "Asks for permission.";
    case "question":
      return item.ask || "Has a question.";
    case "proposal":
      return item.ask ? `Proposes: ${item.ask}` : "Has a proposal.";
    case "ready":
      return item.ask ? `Ready to merge: ${item.ask}` : "Ready to merge.";
    case "error":
      return item.ask || "Stopped with an error.";
    case "finished":
      return "Finished.";
  }
}

/** One line, at most `max` characters. */
function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1).trimEnd()}…`;
}

// Sending.

/** One push, ready to post: the encrypted body and its headers (RFC 8030, 8291, 8292). */
export interface PushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** What the push service answered: its status (0: no answer) and any Retry-After. */
export interface PushResponse {
  status: number;
  retryAfter: string | null;
}

/** Posts a push; tests pass a fake. */
export type PushSend = (request: PushRequest) => Promise<PushResponse>;

/** Posts with `fetch`. A network failure or timeout is status 0. */
export const fetchSend: PushSend = async ({ endpoint, headers, body }) => {
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    await response.body?.cancel();
    return { status: response.status, retryAfter: response.headers.get("retry-after") };
  } catch {
    return { status: 0, retryAfter: null };
  }
};

/**
 * The request for one message to one subscription: the payload encrypted to the browser
 * (aes128gcm), and a VAPID JWT for the push service's origin, signed with the daemon's key.
 * `topic`: an undelivered message with the same topic is replaced (one per thread).
 */
export function pushRequest(
  subscription: PushTarget["subscription"],
  message: PushMessage,
  { keys, contact, topic }: { keys: VapidKeys; contact: string; topic?: string | undefined },
): PushRequest {
  const payload = JSON.stringify(message);
  const encrypted = webpush.encrypt(
    subscription.keys.p256dh,
    subscription.keys.auth,
    payload,
    "aes128gcm",
  );
  const audience = new URL(subscription.endpoint).origin;
  const { Authorization } = webpush.getVapidHeaders(
    audience,
    contact,
    keys.publicKey,
    keys.privateKey,
    "aes128gcm",
  );
  const headers: Record<string, string> = {
    Authorization,
    TTL: String(PUSH_TTL_S),
    Urgency: "high",
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "aes128gcm",
  };
  // A topic is at most 32 base64url characters; a thread id ("thr_" + 20) is one.
  if (topic && /^[A-Za-z0-9_-]{1,32}$/.test(topic)) headers.Topic = topic;
  return { endpoint: subscription.endpoint, headers, body: new Uint8Array(encrypted.cipherText) };
}

// The notifier.

/** What `Push` listens to: the engine's changes, and a thread's name. */
export interface PushSource {
  subscribe(listener: (change: EngineChange) => void): () => void;
  view(threadId: string): { title: string };
}

/** One open socket of a device, telling whether its page is in view. */
export interface Presence {
  /** The socket said something: it is alive. */
  heard(): void;
  /** Its page is in view, or not. */
  visible(visible: boolean): void;
  /** The socket closed. */
  close(): void;
}

export interface PushOptions {
  devices: Devices;
  keys: VapidKeys;
  /** VAPID `sub`: a mailto: or https: URL (`TENZO_PUSH_CONTACT`). */
  contact?: string;
  preview?: PushPreview;
  send?: PushSend;
  debounceMs?: number;
  retryDelaysMs?: readonly number[];
  now?: () => number;
  log?: (message: string) => void;
}

export class Push {
  readonly #devices: Devices;
  readonly #keys: VapidKeys;
  readonly #contact: string;
  readonly #preview: PushPreview;
  readonly #send: PushSend;
  readonly #debounceMs: number;
  readonly #retryDelays: readonly number[];
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  #source: PushSource | undefined;
  #unsubscribe: (() => void) | undefined;
  /** Open, awake quick-lane cards, as the engine announced them. */
  readonly #open = new Map<QueueItemId, QueueItem>();
  /** Cards a push went out for (or was decided against): each pushes once until snoozed. */
  readonly #announced = new Set<QueueItemId>();
  /** A thread's pending push, waiting out the burst. */
  readonly #pending = new Map<ThreadId, NodeJS.Timeout>();
  /** Retries waiting. */
  readonly #retries = new Set<NodeJS.Timeout>();
  /** Each open socket of a paired device: is its page in view, and when did it last talk. */
  readonly #presence = new Map<symbol, { deviceId: string; visible: boolean; heardAt: number }>();
  #closed = false;

  constructor({
    devices,
    keys,
    contact = DEFAULT_PUSH_CONTACT,
    preview = "short",
    send = fetchSend,
    debounceMs = DEBOUNCE_MS,
    retryDelaysMs = RETRY_DELAYS_MS,
    now = Date.now,
    log = (message) => console.error(`tenzo: ${message}`),
  }: PushOptions) {
    this.#devices = devices;
    this.#keys = keys;
    this.#contact = contact;
    this.#preview = preview;
    this.#send = send;
    this.#debounceMs = debounceMs;
    this.#retryDelays = retryDelaysMs;
    this.#now = now;
    this.#log = log;
  }

  /** The key browsers subscribe with. */
  get publicKey(): string {
    return this.#keys.publicKey;
  }

  /** Starts listening to the engine. Cards already open when it starts don't push. */
  start(source: PushSource): void {
    this.#source = source;
    this.#unsubscribe = source.subscribe((change) => this.#changed(change));
  }

  /** Stops: nothing more is sent, pending pushes and retries are dropped. */
  close(): void {
    this.#closed = true;
    this.#unsubscribe?.();
    for (const timer of this.#pending.values()) clearTimeout(timer);
    for (const timer of this.#retries) clearTimeout(timer);
    this.#pending.clear();
    this.#retries.clear();
  }

  /** A paired device's socket opened; it reports whether its page is in view (socket.ts). */
  presence(deviceId: string): Presence {
    const key = Symbol(deviceId);
    this.#presence.set(key, { deviceId, visible: false, heardAt: this.#now() });
    return {
      heard: () => {
        const entry = this.#presence.get(key);
        if (entry) entry.heardAt = this.#now();
      },
      visible: (visible) => {
        const entry = this.#presence.get(key);
        if (entry) Object.assign(entry, { visible, heardAt: this.#now() });
      },
      close: () => {
        this.#presence.delete(key);
      },
    };
  }

  /** True while the device has Tenzo open and in view on a socket that is still talking. */
  inView(deviceId: string): boolean {
    const now = this.#now();
    for (const entry of this.#presence.values()) {
      if (entry.deviceId === deviceId && entry.visible && now - entry.heardAt < VISIBLE_FRESH_MS) {
        return true;
      }
    }
    return false;
  }

  /** A test notification for a device, now, muted or not; resolves once its push service answered. */
  async test(deviceId: string): Promise<{ sent: boolean; error: string | null }> {
    const target = this.#devices.pushTarget(deviceId);
    if (!target) {
      return { sent: false, error: "This device hasn't turned notifications on." };
    }
    const message: PushMessage = {
      tag: "tenzo-test",
      title: "Tenzo",
      body: `Notifications work on ${clip(target.name, 40)}.`,
      url: "/devices",
    };
    const { status } = await this.#post(target, message, undefined);
    if (status >= 200 && status < 300) return { sent: true, error: null };
    if (status === 404 || status === 410) {
      this.#devices.dropSubscription(target.deviceId, target.subscription.endpoint);
      return {
        sent: false,
        error: "The browser's push service no longer knows this device. Turn notifications on again.",
      };
    }
    return {
      sent: false,
      error:
        status === 0
          ? "Couldn't reach the push service."
          : `The push service refused it (${status}).`,
    };
  }

  #changed(change: EngineChange): void {
    if (this.#closed) return;
    if (change.type === "thread") {
      if (change.thread.status === "archived") this.#forgetThread(change.thread.id);
      return;
    }
    if (change.type !== "item") return;
    const { type, item } = change.change;
    if (!pushes(item)) {
      this.#open.delete(item.id);
      // A snoozed card pushes again when it comes back; a resolved one is gone for good.
      this.#announced.delete(item.id);
      if (![...this.#open.values()].some((i) => i.threadId === item.threadId)) {
        this.#cancel(item.threadId);
      }
      return;
    }
    this.#open.set(item.id, item);
    if (type === "opened" || type === "unsnoozed") this.#schedule(item.threadId);
  }

  #schedule(threadId: ThreadId): void {
    if (this.#pending.has(threadId)) return; // the burst's push is already coming
    const timer = setTimeout(() => {
      this.#pending.delete(threadId);
      this.#flush(threadId);
    }, this.#debounceMs);
    timer.unref();
    this.#pending.set(threadId, timer);
  }

  #cancel(threadId: ThreadId): void {
    clearTimeout(this.#pending.get(threadId));
    this.#pending.delete(threadId);
  }

  #forgetThread(threadId: ThreadId): void {
    this.#cancel(threadId);
    for (const [id, item] of this.#open) {
      if (item.threadId === threadId) {
        this.#open.delete(id);
        this.#announced.delete(id);
      }
    }
  }

  /** The burst is over: one push for the thread's newest card nobody was told of yet. */
  #flush(threadId: ThreadId): void {
    if (this.#closed) return;
    const open = [...this.#open.values()].filter((item) => item.threadId === threadId);
    const fresh = open.filter((item) => !this.#announced.has(item.id));
    const item = fresh.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    if (!item) return;
    for (const each of open) this.#announced.add(each.id);
    const message = pushMessageOf(item, this.#titleOf(threadId), this.#preview);
    for (const target of this.#devices.pushTargets()) {
      if (target.muted || this.inView(target.deviceId)) continue;
      void this.#deliver(target, message, item.id, 0);
    }
  }

  #titleOf(threadId: ThreadId): string {
    try {
      return this.#source?.view(threadId).title ?? "";
    } catch {
      return "";
    }
  }

  /** Sends one card's push to one device, retrying while it is still open and wanted. */
  async #deliver(
    target: PushTarget,
    message: PushMessage,
    itemId: QueueItemId,
    attempt: number,
  ): Promise<void> {
    const { status, retryAfter } = await this.#post(target, message, message.tag);
    if (this.#closed || (status >= 200 && status < 300)) return;
    const device = target.deviceId;
    if (status === 404 || status === 410) {
      if (this.#devices.dropSubscription(device, target.subscription.endpoint)) {
        this.#log(`push: ${device}'s subscription is gone (${status}); forgot it`);
      }
      return;
    }
    const delay = this.#retryDelays[attempt];
    const transient = status === 0 || status === 429 || status >= 500;
    if (!transient || delay === undefined) {
      this.#log(`push to ${device} failed (${status || "no answer"}); not retrying`);
      return;
    }
    const timer = setTimeout(
      () => {
        this.#retries.delete(timer);
        // Still worth it? The card is open, the device subscribed (the same browser), unmuted,
        // and not looking at Tenzo now.
        const now = this.#devices.pushTarget(device);
        if (
          !this.#open.has(itemId) ||
          !now ||
          now.muted ||
          now.subscription.endpoint !== target.subscription.endpoint ||
          this.inView(device)
        ) {
          return;
        }
        void this.#deliver(now, message, itemId, attempt + 1);
      },
      Math.max(delay, retryAfterMs(retryAfter, this.#now())),
    );
    timer.unref();
    this.#retries.add(timer);
  }

  /** Posts one message; never throws (a failure to even build it is status 0, logged). */
  async #post(
    target: PushTarget,
    message: PushMessage,
    topic: string | undefined,
  ): Promise<PushResponse> {
    try {
      const request = pushRequest(target.subscription, message, {
        keys: this.#keys,
        contact: this.#contact,
        topic,
      });
      return await this.#send(request);
    } catch (error) {
      this.#log(`push to ${target.deviceId} couldn't be sent: ${String(error)}`);
      return { status: 0, retryAfter: null };
    }
  }
}

/** A Retry-After (seconds, or an HTTP date) in ms from `now`, capped; 0 when absent or garbage. */
export function retryAfterMs(value: string | null, now: number): number {
  if (!value) return 0;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(ms) ? Math.min(Math.max(0, ms), MAX_RETRY_AFTER_MS) : 0;
}
