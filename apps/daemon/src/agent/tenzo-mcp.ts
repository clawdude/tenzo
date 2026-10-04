import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
import { type Check, CheckStatus } from "@tenzo/contracts";
import { z } from "zod";

/**
 * Tenzo's own MCP server, injected into every Claude thread next to the user's MCP servers
 * (PRODUCT.md §4, §6): the tools an agent uses to talk to Tenzo rather than to the code.
 *
 * It runs inside the daemon, through the Agent SDK's in-process transport: no extra process, no
 * port, no token. The SDK passes it to Claude Code as one more server (`--mcp-config`), so the
 * servers from the user's own config load exactly as before. T3 Code injects its `t3-code`
 * server the same way, over HTTP.
 *
 * The tools only describe and validate; what they do is the session's (`TenzoToolHost`, in
 * claude.ts), so a Codex adapter can serve the same host over its own transport later. Tools:
 * `propose` (#19); `report`, `attach`, `expose` (#20). #21 adds `wake_me` and `start_thread`.
 */
export const TENZO_MCP_SERVER = "tenzo";

/** How Claude names one of the server's tools: `mcp__tenzo__propose`. */
export function tenzoToolName(name: string): string {
  return `mcp__${TENZO_MCP_SERVER}__${name}`;
}

/** Tenzo's tools are Tenzo's to allow: they never ask the user for permission to be used. */
export function isTenzoTool(toolName: string): boolean {
  return toolName.startsWith(tenzoToolName(""));
}

export const PROPOSE = "propose";
export const REPORT = "report";
export const ATTACH = "attach";
export const EXPOSE = "expose";

export interface ProposeInput {
  summary: string;
  headline?: string | undefined;
}

export interface ReportInput {
  summary: string;
  how_to_test: string;
  checks: Check[];
  headline?: string | undefined;
}

export interface AttachInput {
  path: string;
  caption?: string | undefined;
}

export interface ExposeInput {
  port: number;
  path?: string | undefined;
}

/** A tool's answer to the agent. `isError`: the call didn't do what it was for. */
export interface ToolReply {
  text: string;
  isError?: boolean;
}

/** What the tools do, per session. */
export interface TenzoToolHost {
  /** Shows the proposal and resolves once the user has decided; `signal` withdraws it. */
  propose(input: ProposeInput, signal: AbortSignal | undefined): Promise<ToolReply>;
  /** Hands the finished work over for review, and returns at once. */
  report(input: ReportInput): Promise<ToolReply>;
  /** Takes a screenshot from the worktree for the next report. */
  attach(input: AttachInput): Promise<ToolReply>;
  /** Forwards the thread's live base to a dev server's port. */
  expose(input: ExposeInput): Promise<ToolReply>;
}

/** What the tool descriptions name for this thread. */
export interface ToolContext {
  /** The path the thread's dev server is reachable under: `/live/<thread>/`. */
  liveBase: string;
}

/**
 * Per-call timeout for the server, ms. A proposal waits for a person, so the call must not be
 * cut by a short `MCP_TOOL_TIMEOUT` the user set for their own servers. 24 days: under the
 * 2^31 ms a Node timer can hold.
 */
export const TOOL_TIMEOUT_MS = 24 * 24 * 60 * 60 * 1000;

const PROPOSE_DESCRIPTION = [
  "Propose what you're going to do and wait for the go-ahead. Call it once you know what the request needs, before changing anything.",
  "The person sees the headline and the summary as a card and answers Build it (the result starts with \"Approved, build it.\": go ahead) or with what to change (revise, and propose again).",
  "The call waits until they answer, which can take a while. One proposal at a time.",
].join(" ");

const REPORT_DESCRIPTION = [
  "Hand the finished work to the person for review. Call it once, when the work is built, checked and committed.",
  "They see a card with your headline, the summary, how to test it, a badge per check, the screenshots you attached and the dev server you exposed: attach and expose first.",
  "It returns at once; then end your turn with one short line. Their answer comes back to you as a message. Reporting again replaces the card.",
].join(" ");

const ATTACH_DESCRIPTION = [
  "Attach a screenshot to your next report: a PNG, JPEG, GIF or WebP file inside this worktree, up to 10 MB.",
  "When the change has something to see, take one with what the machine already has (an installed Chrome: `--headless --screenshot=shot.png --window-size=390,844 <url>`; or the project's own Playwright), save it in the worktree, and attach it before you report.",
].join(" ");

function exposeDescription(base: string): string {
  return [
    "Make a dev server running in this worktree reachable from the person's phone, as the card's \"Open live\" link.",
    `Tenzo forwards ${base} on its own address to localhost:<port>, paths unchanged, so the server must serve under that base: Vite \`npx vite --port 5173 --base ${base}\` (also in $TENZO_LIVE_BASE); for others, their base-path option.`,
    "Start it in the background so it keeps running after your turn, then call expose before you report.",
  ].join(" ");
}

export function tenzoTools(host: TenzoToolHost, context: ToolContext) {
  return [
    tool(
      PROPOSE,
      PROPOSE_DESCRIPTION,
      {
        summary: z
          .string()
          .min(1)
          .describe(
            "What you'll change, where, and how you'll check it: a few short lines a person can read on a phone.",
          ),
        headline: z
          .string()
          .optional()
          .describe('The plan in a few words, e.g. "Add CONTRIBUTING.md with three rules".'),
      },
      async (args, extra) => toolResult(await host.propose(args, signalOf(extra))),
    ),
    tool(
      REPORT,
      REPORT_DESCRIPTION,
      {
        summary: z
          .string()
          .min(1)
          .max(4000)
          .describe("The handoff note: what changed, and anything not done. A few short lines; Markdown."),
        how_to_test: z
          .string()
          .max(2000)
          .describe("How the person tries it: steps, a command, the page to open. Markdown."),
        checks: z
          .array(
            z.object({
              name: z.string().min(1).max(60).describe('"Tests", "Typecheck", "Lint", …'),
              status: CheckStatus.describe("pass, fail, or skipped (not run)"),
              detail: z.string().max(500).optional().describe('"42 passed", the failing line, …'),
            }),
          )
          .max(20)
          .describe("Each check you ran and how it went. Report a failure as fail; never leave it out."),
        headline: z
          .string()
          .max(90)
          .optional()
          .describe('What is done in a few words, e.g. "Dark mode toggle works".'),
      },
      async (args) => toolResult(await host.report(args)),
    ),
    tool(
      ATTACH,
      ATTACH_DESCRIPTION,
      {
        path: z.string().min(1).describe("The image's path, relative to the worktree or absolute."),
        caption: z.string().max(200).optional().describe("What it shows, in a few words."),
      },
      async (args) => toolResult(await host.attach(args)),
    ),
    tool(
      EXPOSE,
      exposeDescription(context.liveBase),
      {
        port: z.number().int().describe("The dev server's port on localhost."),
        path: z
          .string()
          .max(300)
          .optional()
          .describe('The page to open, relative to the base, e.g. "counter". Default: the base.'),
      },
      async (args) => toolResult(await host.expose(args)),
    ),
  ];
}

/** The server for one session's `mcpServers`. Each session needs its own: an instance connects once. */
export function tenzoMcpServer(
  host: TenzoToolHost,
  context: ToolContext,
): McpSdkServerConfigWithInstance {
  return {
    ...createSdkMcpServer({
      name: TENZO_MCP_SERVER,
      // Always in the prompt, never deferred behind tool search: the thread prompts name them.
      alwaysLoad: true,
      tools: tenzoTools(host, context),
    }),
    timeout: TOOL_TIMEOUT_MS,
  };
}

/** A proposal as the card shows it: the headline given, else the summary's first sentence. */
export function proposalOf(input: ProposeInput): { headline: string; summary: string } {
  const summary = input.summary.trim();
  const given = input.headline?.replaceAll(/\s+/g, " ").trim();
  return { headline: given || firstSentence(summary), summary };
}

/** A report as the event carries it: tidied, empty parts left out. */
export function reportOf(input: ReportInput): {
  headline?: string;
  summary: string;
  howToTest: string;
  checks: Check[];
} {
  const headline = input.headline?.replaceAll(/\s+/g, " ").trim();
  return {
    ...(headline ? { headline } : {}),
    summary: input.summary.trim(),
    howToTest: input.how_to_test.trim(),
    checks: input.checks.map((c) => ({
      name: c.name.trim(),
      status: c.status,
      ...(c.detail?.trim() ? { detail: c.detail.trim() } : {}),
    })),
  };
}

const HEADLINE_LIMIT = 90;

/** The first sentence of the first line that says something: a heading alone is not a headline. */
function firstSentence(text: string): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const line = lines.find((l) => !/^\s*#/.test(l)) ?? lines[0] ?? "";
  const flat = line.replace(/^[\s#*>-]+/, "").replaceAll(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  return sentence.length <= HEADLINE_LIMIT
    ? sentence
    : `${sentence.slice(0, HEADLINE_LIMIT - 1).trimEnd()}…`;
}

function toolResult(reply: ToolReply) {
  return {
    content: [{ type: "text" as const, text: reply.text }],
    ...(reply.isError ? { isError: true } : {}),
  };
}

/** The MCP request's abort signal: Claude cancels the call when its turn is interrupted. */
function signalOf(extra: unknown): AbortSignal | undefined {
  if (typeof extra !== "object" || extra === null) return undefined;
  const signal = (extra as { signal?: unknown }).signal;
  return signal instanceof AbortSignal ? signal : undefined;
}
