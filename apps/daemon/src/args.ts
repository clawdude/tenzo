import { TenzoError } from "./errors.ts";

/**
 * Splits arguments into known `--flags`, known `--options <value>` (or `--option=value`) and
 * positionals. An unknown `--flag` is an error, not silently dropped; everything after a bare
 * `--` is positional, so titles and prompts can start with `--`.
 */
export function parseArgs(
  args: readonly string[],
  allowed: readonly string[] = [],
  valued: readonly string[] = [],
): { flags: Set<string>; options: Map<string, string>; positional: string[] } {
  const flags = new Set<string>();
  const options = new Map<string, string>();
  const positional: string[] = [];
  let onlyPositional = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    const [name, inline] = splitOption(arg);
    if (onlyPositional || !arg.startsWith("--")) positional.push(arg);
    else if (arg === "--") onlyPositional = true;
    else if (allowed.includes(arg)) flags.add(arg);
    else if (valued.includes(name)) {
      const value = inline ?? args[++i];
      if (value === undefined || value === "" || (inline === undefined && value.startsWith("--"))) {
        throw new TenzoError(`${name} needs a value, e.g. ${name} <value>.`);
      }
      options.set(name, value);
    } else {
      const known = [...allowed, ...valued.map((v) => `${v} <value>`)];
      const hint = known.length > 0 ? ` Known: ${known.join(", ")}.` : "";
      throw new TenzoError(
        `Unknown option "${arg}".${hint} Put \`--\` before text that starts with --.`,
      );
    }
  }
  return { flags, options, positional };
}

/** `--model=haiku` → `["--model", "haiku"]`; anything else → `[arg, undefined]`. */
function splitOption(arg: string): [string, string | undefined] {
  const eq = arg.indexOf("=");
  return eq > 2 ? [arg.slice(0, eq), arg.slice(eq + 1)] : [arg, undefined];
}
