import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** `<prefix>_` plus 20 random lowercase alphanumerics, e.g. `thr_k3x0…`. */
export function randomId<P extends string>(prefix: P): `${P}_${string}` {
  // 252 is the largest multiple of 36 below 256: rejecting bytes above it keeps the draw uniform.
  let body = "";
  while (body.length < 20) {
    for (const byte of randomBytes(32)) {
      if (byte < 252 && body.length < 20) body += ALPHABET[byte % 36];
    }
  }
  return `${prefix}_${body}`;
}
