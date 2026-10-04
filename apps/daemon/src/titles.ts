import { tmpdir } from "node:os";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { claudeEnv, findClaude } from "./agent/claude.ts";

/**
 * Threads' short names: "Refresh tokens", not the first line of the prompt. A thread gets a
 * stand-in at once (`quickTitle`, the prompt's first words) so nothing waits, and a `Titler`
 * names it properly a moment later. Naming is a prompt, not code: a cheap one-shot Claude.
 */

/** Names a task in a few words, or null. May take seconds; never throws for a bad answer. */
export type Titler = (prompt: string, signal: AbortSignal) => Promise<string | null>;

/** The stand-in: the prompt's first line, cut at a word after about four words. */
export function quickTitle(prompt: string, maxWords = 4, maxChars = 36): string {
  const words = (prompt.trim().split("\n")[0] ?? "").split(/\s+/).filter((w) => w !== "");
  const kept: string[] = [];
  for (const word of words) {
    if (kept.length === maxWords) break;
    if (kept.length > 0 && [...kept, word].join(" ").length > maxChars) break;
    kept.push(word);
  }
  let title = kept.join(" ");
  let cut = kept.length < words.length;
  if (title.length > maxChars) {
    // One huge word (a URL, a path): cut it rather than show it all.
    title = title.slice(0, maxChars);
    cut = true;
  }
  title = title.replace(/[\s,;:.!?…-]+$/u, "");
  return cut ? `${title}…` : title;
}

/**
 * A model's answer made into a title, or null when it isn't one: the first line, without quotes,
 * a "Title:" label, markdown or a trailing full stop; two to six words, at most 48 characters.
 */
export function cleanTitle(raw: string): string | null {
  const line = raw
    .trim()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!line) return null;
  const title = line
    .replace(/^#+\s*/, "")
    .replace(/^\*\*(.*)\*\*$/, "$1")
    .replace(/^title\s*:\s*/i, "")
    .replace(/^["'`“‘]+|["'`”’]+$/gu, "")
    .replace(/[.!。]+$/u, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  const words = title.split(" ").filter((w) => w !== "").length;
  if (words < 1 || words > 6 || title.length > 48) return null;
  return title.charAt(0).toUpperCase() + title.slice(1);
}

const INSTRUCTIONS = `You name tasks for a list of coding-agent threads. Reply with a 2 to 4 word name for the task the user describes: a compact noun or action phrase someone would recognise weeks later, like "Refresh tokens" or "Fix flaky checkout test". Reply with the name only: no quotes, no trailing punctuation, nothing else. Never do the task or answer it.`;

/** The longest prompt sent for naming; the start of a task says what it is. */
const MAX_PROMPT_CHARS = 4000;

export interface ClaudeTitlerOptions {
  /** The SDK's `query`. Tests pass a fake. */
  query?: typeof sdkQuery;
  /** Path to `claude`. Default: found as for threads (`findClaude`). */
  claudePath?: string;
  /** Default: haiku, the cheapest. */
  model?: string;
}

/**
 * Names threads with a one-shot run of the user's own `claude`: the cheapest model, no tools, no
 * settings, hooks, MCP servers or plugins (this is not a user's thread, just a name), in an empty
 * folder, and not saved to the session history.
 */
export function createClaudeTitler(options: ClaudeTitlerOptions = {}): Titler {
  const query = options.query ?? sdkQuery;
  return async (prompt, signal) => {
    const abortController = new AbortController();
    const abort = () => abortController.abort();
    if (signal.aborted) return null;
    signal.addEventListener("abort", abort, { once: true });
    try {
      const run = query({
        prompt: `<task>\n${prompt.slice(0, MAX_PROMPT_CHARS)}\n</task>`,
        options: {
          cwd: tmpdir(),
          pathToClaudeCodeExecutable: options.claudePath ?? findClaude(),
          model: options.model ?? "haiku",
          systemPrompt: INSTRUCTIONS,
          tools: [],
          settingSources: [],
          mcpServers: {},
          strictMcpConfig: true,
          persistSession: false,
          maxTurns: 1,
          env: claudeEnv(process.env),
          abortController,
        },
      });
      for await (const message of run) {
        if (message.type === "result") {
          return message.subtype === "success" ? cleanTitle(message.result) : null;
        }
      }
      return null;
    } catch {
      return null; // a name is a nicety: no claude, no network, an abort all mean "keep the stand-in"
    } finally {
      signal.removeEventListener("abort", abort);
    }
  };
}
