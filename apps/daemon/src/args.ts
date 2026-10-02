import { TenzoError } from "./errors.ts";

/**
 * Splits arguments into known `--flags` and positionals. An unknown `--flag` is an error, not
 * silently dropped; everything after a bare `--` is positional, so titles can start with `--`.
 */
export function parseArgs(
  args: readonly string[],
  allowed: readonly string[] = [],
): { flags: Set<string>; positional: string[] } {
  const flags = new Set<string>();
  const positional: string[] = [];
  let onlyPositional = false;
  for (const arg of args) {
    if (onlyPositional || !arg.startsWith("--")) positional.push(arg);
    else if (arg === "--") onlyPositional = true;
    else if (allowed.includes(arg)) flags.add(arg);
    else {
      const hint = allowed.length > 0 ? ` Known: ${allowed.join(", ")}.` : "";
      throw new TenzoError(
        `Unknown option "${arg}".${hint} Put \`--\` before text that starts with --.`,
      );
    }
  }
  return { flags, positional };
}
