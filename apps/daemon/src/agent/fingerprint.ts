import { createHash } from "node:crypto";
import type { Fingerprint } from "@tenzo/contracts";

/**
 * What exactly a tool call asks: SHA-256 over the tool's name and its *full* input as canonical
 * JSON (keys sorted at every level). Adapters compute it before cutting the input for display,
 * so two requests that differ anywhere, however deep or far into a long string, differ here.
 * The daemon's standing answers (answers.ts) match on this and nothing else.
 */
export function fingerprintOf(toolName: string, input: unknown): Fingerprint {
  const hash = createHash("sha256").update(canonicalJson([toolName, input])).digest("hex");
  return `sha256:${hash}`;
}

/** JSON with object keys sorted, so the same value always gives the same text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortKeys((value as Record<string, unknown>)[key])]),
  );
}
