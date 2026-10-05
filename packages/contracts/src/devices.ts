import { z } from "zod";

/**
 * Remote access (PRODUCT.md §9). On the Mac itself the daemon needs no login; anything that
 * reaches it from elsewhere (Tailscale Serve) is a paired device: it exchanged a one-time pairing
 * link for its own revocable token.
 */

/** One paired device: a phone, a tablet, another computer's browser. */
export const DeviceId = z.string().regex(/^dev_[a-z0-9]{20}$/);
export type DeviceId = z.infer<typeof DeviceId>;

/** What a person calls a device: "Andreas's iPhone". */
export const DeviceName = z.string().trim().min(1).max(60);

/**
 * A device's notifications (Web Push, PRODUCT.md §9). `subscribed`: its browser gave the daemon
 * a push subscription (`device.subscribe`). `muted`: it gets no pushes until unmuted, subscribed
 * or not.
 */
export const DevicePush = z.object({ subscribed: z.boolean(), muted: z.boolean() });
export type DevicePush = z.infer<typeof DevicePush>;

export const Device = z.object({
  id: DeviceId,
  name: z.string(),
  createdAt: z.string(),
  /** The last time it made a request, to the minute; null when it never did after pairing. */
  lastSeenAt: z.string().nullable(),
  push: DevicePush.default({ subscribed: false, muted: false }),
});
export type Device = z.infer<typeof Device>;

/** base64url, as a browser's `PushSubscription.toJSON()` spells keys. */
const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/);

/**
 * A browser's push subscription (`PushSubscription.toJSON()`): where its push service takes
 * messages for it, and the keys they are encrypted to. Only the browser can read what is sent.
 */
export const PushSubscriptionInfo = z.object({
  endpoint: z
    .url({ protocol: /^https$/ })
    .max(2048)
    .refine((url) => !/^https:\/\/[^/?#]*@/i.test(url), "an endpoint carries no credentials"),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    /** The browser's P-256 public key, uncompressed: 65 bytes. */
    p256dh: Base64Url.min(80).max(100),
    /** The shared auth secret: 16 bytes. */
    auth: Base64Url.min(16).max(32),
  }),
});
export type PushSubscriptionInfo = z.infer<typeof PushSubscriptionInfo>;

/**
 * What a push carries to the service worker, which shows it as a notification. It passes
 * through Apple's or Google's push service (encrypted to the browser, but still): no more than
 * the thread's name and a short line. `tag`: one notification per thread (its id); a newer push
 * for the thread replaces it. `url`: where tapping it goes, a path on Tenzo's own origin.
 */
export interface PushMessage {
  tag: string;
  title: string;
  body: string;
  url: string;
}

/**
 * `GET /api/session`: who the daemon takes this browser for. `local`: on the Mac itself, no
 * pairing needed (`device` null). `remote`: from elsewhere; `device` is this browser's pairing,
 * or null when it has none, and then nothing but this and pairing answers.
 */
export const Session = z.object({
  mode: z.enum(["local", "remote"]),
  device: Device.nullable(),
});
export type Session = z.infer<typeof Session>;

/** `POST /api/pair`: the code from a pairing link, for this browser's own token (a cookie). */
export const PairRequest = z.object({
  code: z.string().min(1).max(200),
  /** What to call this device, when `tenzo pair` wasn't given a name. */
  name: DeviceName.optional(),
});
export type PairRequest = z.infer<typeof PairRequest>;

/** `POST /api/pair`'s answer. On success the token comes as a cookie, never in the body. */
export const PairResponse = z.union([
  z.object({ ok: z.literal(true), device: Device }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type PairResponse = z.infer<typeof PairResponse>;

/** How long a pairing link works, from `tenzo pair`. */
export const PAIRING_TTL_MS = 10 * 60_000;

/** The pairing link a code makes on `origin`: the code rides in the fragment, never sent. */
export function pairingUrl(origin: string, code: string): string {
  return `${origin.replace(/\/+$/, "")}/pair#${code}`;
}

/**
 * The code in what a person pasted: a whole pairing link, its fragment, or the bare code.
 * Null when there is none.
 */
export function pairingCode(text: string): string | null {
  const trimmed = text.trim();
  const hash = trimmed.indexOf("#");
  const code = (hash >= 0 ? trimmed.slice(hash + 1) : trimmed).replace(/[\s-]/g, "");
  return /^[a-z0-9]{16,64}$/i.test(code) ? code.toLowerCase() : null;
}
