import {
  createSdkMcpServer,
  type McpSdkServerConfigWithInstance,
  tool,
} from "@anthropic-ai/claude-agent-sdk";
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
 * claude.ts), so a Codex adapter can serve the same host over its own transport later. First
 * tool: `propose`. #20 and #21 add `report`, `attach`, `expose`, `wake_me`, `start_thread` here.
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

export interface ProposeInput {
  summary: string;
  headline?: string | undefined;
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
  "The call waits until they answer, which can take a while.",
].join(" ");

export function tenzoTools(host: TenzoToolHost) {
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
  ];
}

/** The server for one session's `mcpServers`. Each session needs its own: an instance connects once. */
export function tenzoMcpServer(host: TenzoToolHost): McpSdkServerConfigWithInstance {
  return {
    ...createSdkMcpServer({
      name: TENZO_MCP_SERVER,
      // Always in the prompt, never deferred behind tool search: the discuss prompt names it.
      alwaysLoad: true,
      tools: tenzoTools(host),
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

const HEADLINE_LIMIT = 90;

function firstSentence(text: string): string {
  const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
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
