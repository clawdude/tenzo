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

export const Device = z.object({
  id: DeviceId,
  name: z.string(),
  createdAt: z.string(),
  /** The last time it made a request, to the minute; null when it never did after pairing. */
  lastSeenAt: z.string().nullable(),
});
export type Device = z.infer<typeof Device>;

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
