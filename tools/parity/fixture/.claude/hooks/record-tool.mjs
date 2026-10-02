#!/usr/bin/env node
// The parity check's hook: appends one JSON line per call to .parity/hooks.jsonl in the project,
// so the check can see that it ran and for which tool.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  // Not JSON: still record that the hook ran.
}
const dir = join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), ".parity");
mkdirSync(dir, { recursive: true });
appendFileSync(
  join(dir, "hooks.jsonl"),
  `${JSON.stringify({ hook: input.hook_event_name ?? null, tool: input.tool_name ?? null })}\n`,
);
