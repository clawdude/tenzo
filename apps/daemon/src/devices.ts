import { randomBytes } from "node:crypto";
import { type Device, DeviceId, PAIRING_TTL_MS } from "@tenzo/contracts";
import {
  DEVICE_TTL_MS,
  hashToken,
  LIVE_COOKIE_TTL_MS,
  LIVE_GRANT_TTL_MS,
  newToken,
  RateLimit,
  readLivePass,
  signLivePass,
} from "./auth.ts";
import { TenzoError } from "./errors.ts";
import { randomId } from "./ids.ts";
import { type Store, transaction } from "./store.ts";

/** Failed pairing attempts, all devices together, before attempts wait (auth.ts). */
export const PAIR_ATTEMPTS = { limit: 10, windowMs: 60_000 };

/** How often a device's "last seen" is written, at most. */
const SEEN_EVERY_MS = 60_000;

/** A pairing code's length: 26 of [a-z0-9], about 134 bits. */
const CODE_LENGTH = 26;
const CODE_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Paired devices (PRODUCT.md §9), kept in the store: `tenzo pair` makes a one-time code, a
 * browser trades it (once, within 10 minutes) for its own long-lived token, and the device can be
 * renamed or revoked. Only hashes of codes and tokens are stored. Revoking closes the device's
 * open connections at once (`track`).
 */
export class Devices {
  readonly #store: Store;
  readonly #now: () => number;
  /** Close functions of each device's open connections: the Pass's socket, live apps' sockets. */
  readonly #open = new Map<string, Set<() => void>>();
  readonly #seen = new Map<string, number>();
  #key: Buffer | undefined;
  /** Where devices reach the daemon (`TENZO_PUBLIC_URL`), for pairing links; null: not said. */
  readonly #publicOrigin: string | null;
  /** Failed pairing attempts (`POST /api/pair`); every new code lifts the limit. */
  readonly pairingAttempts: RateLimit;

  constructor(
    store: Store,
    { now = Date.now, publicOrigin = null }: { now?: () => number; publicOrigin?: string | null } = {},
  ) {
    this.#store = store;
    this.#now = now;
    this.#publicOrigin = publicOrigin;
    this.pairingAttempts = new RateLimit(PAIR_ATTEMPTS.limit, PAIR_ATTEMPTS.windowMs, now);
  }

  /**
   * A new one-time pairing code; `name` is what the device will be called. `origin` is where the
   * link points (`TENZO_PUBLIC_URL`), null when the daemon wasn't told. Lifts the limit on failed
   * attempts: the Mac asked, so pairing must work now.
   */
  pair(name?: string): { code: string; expiresAt: string; origin: string | null } {
    const code = randomCode();
    const now = this.#now();
    const expiresAt = new Date(now + PAIRING_TTL_MS).toISOString();
    this.#store.db
      .prepare(
        "INSERT INTO pairings (code_hash, environment_id, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run(hashToken(code), this.#store.environmentId, name ?? null, iso(now), expiresAt);
    this.pairingAttempts.reset();
    return { code, expiresAt, origin: this.#publicOrigin };
  }

  /**
   * Trades a pairing code for a new device and its token: once, before it expires. Null for a
   * code that is unknown, used or expired (which one isn't said).
   */
  exchange(code: string, fallbackName: string): { device: Device; token: string } | null {
    const now = iso(this.#now());
    return transaction(this.#store, () => {
      const row = this.#store.db
        .prepare(
          "SELECT name FROM pairings WHERE code_hash = ? AND used_at IS NULL AND expires_at > ?",
        )
        .get(hashToken(code), now) as { name: string | null } | undefined;
      if (!row) return null;
      const token = newToken();
      const id = randomId("dev");
      const name = row.name ?? fallbackName;
      this.#store.db
        .prepare(
          "INSERT INTO devices (id, environment_id, name, token_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run(id, this.#store.environmentId, name, hashToken(token), now, now);
      this.#store.db
        .prepare("UPDATE pairings SET used_at = ?, device_id = ? WHERE code_hash = ?")
        .run(now, id, hashToken(code));
      return { device: { id, name, createdAt: now, lastSeenAt: now }, token };
    });
  }

  /** The active device a token belongs to, or null; notes that it was seen. */
  authenticate(token: string | null | undefined): Device | null {
    if (!token) return null;
    const row = this.#store.db
      .prepare("SELECT * FROM devices WHERE token_hash = ? AND revoked_at IS NULL")
      .get(hashToken(token));
    if (!row) return null;
    return this.#touch(toDevice(row));
  }

  /** The active device with this id, or null. */
  find(id: string): Device | null {
    const row = this.#store.db
      .prepare("SELECT * FROM devices WHERE id = ? AND revoked_at IS NULL")
      .get(id);
    return row ? toDevice(row) : null;
  }

  /** Active devices, oldest first. */
  list(): Device[] {
    return this.#store.db
      .prepare("SELECT * FROM devices WHERE revoked_at IS NULL ORDER BY created_at, id")
      .all()
      .map(toDevice);
  }

  rename(id: string, name: string): Device {
    const device = this.#active(id);
    this.#store.db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(name, device.id);
    return { ...device, name };
  }

  /** Revokes a device: its token stops working, and its open connections close now. */
  revoke(id: string): Device {
    const device = this.#active(id);
    this.#store.db
      .prepare("UPDATE devices SET revoked_at = ? WHERE id = ?")
      .run(iso(this.#now()), device.id);
    const open = this.#open.get(device.id);
    this.#open.delete(device.id);
    this.#seen.delete(device.id);
    for (const close of open ?? []) {
      try {
        close();
      } catch {
        // already gone
      }
    }
    return device;
  }

  /**
   * Registers one of a device's open connections, to be closed when it is revoked. Returns the
   * function that unregisters it (when it closes by itself).
   */
  track(deviceId: string, close: () => void): () => void {
    let set = this.#open.get(deviceId);
    if (!set) {
      set = new Set();
      this.#open.set(deviceId, set);
    }
    set.add(close);
    return () => {
      set.delete(close);
      if (set.size === 0 && this.#open.get(deviceId) === set) this.#open.delete(deviceId);
    };
  }

  /** A pass to the live origin for Open live links (`LiveInfo.grant`). */
  liveGrant(deviceId: string): string {
    return signLivePass(this.#liveKey(), deviceId, this.#now() + LIVE_GRANT_TTL_MS);
  }

  /**
   * The live origin's cookie for a device: a pass that lasts 30 days, never longer than the
   * device's own cookie. `expiresAt` is for the cookie's Max-Age.
   */
  livePass(deviceId: string): { pass: string; expiresAt: number } {
    const device = this.find(deviceId);
    const end = device ? Date.parse(device.createdAt) + DEVICE_TTL_MS : 0;
    const expiresAt = Math.min(this.#now() + LIVE_COOKIE_TTL_MS, end);
    return { pass: signLivePass(this.#liveKey(), deviceId, expiresAt), expiresAt };
  }

  /** The active device a live pass or grant names, or null. */
  checkLivePass(pass: string | null | undefined): Device | null {
    const id = readLivePass(this.#liveKey(), pass, this.#now());
    const device = id ? this.find(id) : null;
    return device ? this.#touch(device) : null;
  }

  /** The device, if active; a TenzoError naming the id otherwise. */
  #active(id: string): Device {
    const device = DeviceId.safeParse(id).success ? this.find(id) : null;
    if (!device) {
      throw new TenzoError(`No paired device "${id}". \`tenzo devices\` lists them.`);
    }
    return device;
  }

  /** Writes "last seen" now and then, not on every request. */
  #touch(device: Device): Device {
    const now = this.#now();
    if (now - (this.#seen.get(device.id) ?? 0) < SEEN_EVERY_MS) return device;
    this.#seen.set(device.id, now);
    const at = iso(now);
    this.#store.db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(at, device.id);
    return { ...device, lastSeenAt: at };
  }

  /** The key live passes are signed with: made once, kept in the database. */
  #liveKey(): Buffer {
    if (this.#key) return this.#key;
    this.#store.db
      .prepare("INSERT OR IGNORE INTO auth_keys (name, key) VALUES ('live', ?)")
      .run(randomBytes(32));
    const row = this.#store.db.prepare("SELECT key FROM auth_keys WHERE name = 'live'").get() as {
      key: Uint8Array;
    };
    this.#key = Buffer.from(row.key);
    return this.#key;
  }
}

/**
 * Where `tenzo pair`'s link points: `--url`, else where the daemon says devices reach it
 * (its `TENZO_PUBLIC_URL`). Never a guess: a Serve route on another port than 443 would make a
 * portless guess a dead link. A TenzoError says what to set.
 */
export function pairingOrigin(daemonOrigin: string | null, flag?: string): string {
  if (flag !== undefined) {
    let url: URL | undefined;
    try {
      url = new URL(flag);
    } catch {
      // said below
    }
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) {
      throw new TenzoError(
        `--url takes where the device reaches Tenzo, like https://my-mac.tailnet.ts.net:8443; got "${flag}".`,
      );
    }
    return url.origin;
  }
  if (daemonOrigin) return daemonOrigin;
  throw new TenzoError(
    "The daemon doesn't know where devices reach it. Set TENZO_PUBLIC_URL to its Tailscale Serve address, port included (e.g. https://my-mac.tailnet.ts.net:8443), and restart the daemon; or pass it now with --url.",
  );
}

/** A name for a device that pairs without one, from its browser's User-Agent. */
export function nameFromUserAgent(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return /Mobile/.test(ua) ? "Android phone" : "Android tablet";
  if (/Macintosh|Mac OS X/.test(ua)) return "Mac";
  if (/Windows/.test(ua)) return "Windows PC";
  if (/Linux|X11/.test(ua)) return "Linux";
  return "Device";
}

function randomCode(): string {
  // 252 is the largest multiple of 36 below 256: rejecting bytes above it keeps the draw uniform.
  let code = "";
  while (code.length < CODE_LENGTH) {
    for (const byte of randomBytes(48)) {
      if (byte < 252 && code.length < CODE_LENGTH) code += CODE_ALPHABET[byte % 36];
    }
  }
  return code;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function toDevice(row: Record<string, unknown>): Device {
  return {
    id: DeviceId.parse(row.id),
    name: String(row.name),
    createdAt: String(row.created_at),
    lastSeenAt: row.last_seen_at === null ? null : String(row.last_seen_at),
  };
}
