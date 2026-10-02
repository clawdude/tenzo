import type {
  Options,
  PermissionResult,
  Query,
  query as sdkQuery,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

/**
 * Test-only: SDK messages shaped like the ones Claude Code sends (trimmed to the fields Tenzo
 * reads), and a fake `query` that plays a script instead of spawning Claude.
 */

export const SESSION = "5b0c7a6e-3f1d-4c2b-9a8e-1d2c3b4a5f60";
let counter = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;

export function init(overrides: Partial<SDKSystemMessage> = {}): SDKMessage {
  return {
    type: "system",
    subtype: "init",
    apiKeySource: "none",
    claude_code_version: "2.1.287",
    cwd: "/tmp/worktree",
    tools: ["Bash", "Edit", "Read", "AskUserQuestion", "mcp__notes__add"],
    mcp_servers: [{ name: "notes", status: "connected", source: "user" }],
    model: "claude-haiku-4-5",
    permissionMode: "acceptEdits",
    slash_commands: ["review"],
    output_style: "default",
    skills: ["pdf"],
    plugins: [{ name: "superpowers", path: "/plugins/superpowers" }],
    agents: ["general-purpose"],
    uuid: uuid(),
    session_id: SESSION,
    ...overrides,
  } as SDKMessage;
}

type Block =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };

export function assistant(
  content: Block[],
  overrides: Partial<SDKAssistantMessage> = {},
): SDKMessage {
  return {
    type: "assistant",
    message: { id: "msg_1", role: "assistant", content, model: "claude-haiku-4-5" },
    parent_tool_use_id: null,
    uuid: uuid(),
    session_id: SESSION,
    ...overrides,
  } as unknown as SDKMessage;
}

export const text = (t: string): Block => ({ type: "text", text: t });
export const toolUse = (id: string, name: string, input: Record<string, unknown>): Block => ({
  type: "tool_use",
  id,
  name,
  input,
});

export function toolResult(
  toolUseId: string,
  content: string | { type: "text"; text: string }[],
  isError = false,
  overrides: Partial<SDKUserMessage> = {},
): SDKMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: toolUseId, content, is_error: isError }],
    },
    parent_tool_use_id: null,
    uuid: uuid(),
    session_id: SESSION,
    ...overrides,
  } as unknown as SDKMessage;
}

export function result(
  overrides: Partial<SDKResultMessage> & { subtype?: SDKResultMessage["subtype"] } = {},
): SDKMessage {
  return {
    type: "result",
    subtype: "success",
    duration_ms: 1234,
    duration_api_ms: 1000,
    is_error: false,
    num_turns: 1,
    result: "Done.",
    stop_reason: "end_turn",
    total_cost_usd: 0.0021,
    usage: {},
    modelUsage: {},
    permission_denials: [],
    uuid: uuid(),
    session_id: SESSION,
    ...overrides,
  } as unknown as SDKMessage;
}

/** What a script sees for each prompt Tenzo sends. */
export interface Turn {
  prompt: SDKUserMessage;
  options: Options;
  /** Calls the adapter's `canUseTool` the way Claude does before running a tool. */
  canUseTool(
    name: string,
    input: Record<string, unknown>,
    toolUseID: string,
  ): Promise<PermissionResult | null>;
  /** Aborts the pending `canUseTool` calls, as Claude does on interrupt. */
  abort(): void;
}

export type Script = (turn: Turn) => AsyncIterable<SDKMessage> | Iterable<SDKMessage>;

/**
 * A fake `query`: records its options, then for each prompt plays `script`. Ends when the
 * prompt stream ends, like Claude does when its stdin closes; with `exitError`, it then fails the
 * way the SDK does when Claude exits with a non-zero code.
 */
export function fakeQuery(script: Script, fake: { exitError?: Error } = {}) {
  const calls: Options[] = [];
  let interrupts = 0;
  let closed = false;
  const query = ((params: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => {
    const options = params.options;
    calls.push(options);
    let controller = new AbortController();
    async function* run(): AsyncGenerator<SDKMessage, void> {
      for await (const prompt of params.prompt) {
        if (closed) return;
        controller = new AbortController();
        const turn: Turn = {
          prompt,
          options,
          canUseTool: (name, input, toolUseID) => {
            if (!options.canUseTool) throw new Error("no canUseTool");
            return options.canUseTool(name, input, {
              signal: controller.signal,
              toolUseID,
              requestId: `ctl_${toolUseID}`,
            });
          },
          abort: () => controller.abort(),
        };
        for await (const message of script(turn)) {
          if (closed) return;
          yield message;
        }
      }
      if (fake.exitError) throw fake.exitError;
    }
    return Object.assign(run(), {
      interrupt: async () => {
        interrupts++;
        controller.abort();
        return undefined;
      },
      close: () => {
        closed = true;
      },
    }) as unknown as Query;
  }) as unknown as typeof sdkQuery;
  return {
    query,
    calls,
    get interrupts() {
      return interrupts;
    },
  };
}
