import { cpSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

/** The parity project's template. */
export const FIXTURE_DIR = resolve(import.meta.dirname, "../fixture");

/**
 * Names stored inert in this repo → the names Claude Code looks for. Stored under their real
 * names, Claude Code sessions working on Tenzo itself would discover the fixture's config (it
 * finds `.claude/skills` in subdirectories); the copy gets the real names.
 */
export const INERT_NAMES = {
  "dot-claude": ".claude",
  "dot-mcp.json": ".mcp.json",
} as const;

/** Copies the fixture to `dest` (which must not exist) as a live project. */
export function copyFixture(dest: string): void {
  cpSync(FIXTURE_DIR, dest, { recursive: true });
  for (const [stored, live] of Object.entries(INERT_NAMES)) {
    renameSync(join(dest, stored), join(dest, live));
  }
}
