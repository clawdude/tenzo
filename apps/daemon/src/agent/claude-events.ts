import type {
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ItemPayload,
  RuntimeEventOf,
  ToolKind,
  TurnId,
  TurnState,
} from "@tenzo/contracts";
import type { EventDraft } from "./agent.ts";

/**
 * Claude Agent SDK messages → Tenzo's runtime events, as a pure function over a small state:
 * same state and message in, same events out. The adapter stamps ids and times on the drafts.
 */
export interface ClaudeTranslation {
  /** The session was started with `resume`. */
  readonly resumed: boolean;
  readonly sessionStarted: boolean;
  /**
   * What the session said it loaded, last: Claude reports it as each turn starts, and Tenzo
   * passes it on the first time and whenever the model changed (Build it, `thread.setModel`).
   */
  readonly configured: Configured | null;
  /**
   * The adapter switched the model and reported it (`session.configured` with the name it
   * asked for): the next init's report, with Claude's full id, is taken quietly.
   */
  readonly switched: boolean;
  /** The turn in progress, if any. */
  readonly turnId: TurnId | null;
  /** The open turn is one Claude started by itself, not one of our prompts. */
  readonly synthetic: boolean;
  /** Tool calls that started and haven't reported a result yet, by tool-use id. */
  readonly tools: ReadonlyMap<string, ToolCall>;
}

interface ToolCall {
  toolName: string;
  toolKind: ToolKind;
  summary: string;
  parentItemId: string | null;
}

/** What a `session.configured` event says the session loaded. */
export type Configured = RuntimeEventOf<"session.configured">["payload"];

export interface Translated {
  state: ClaudeTranslation;
  events: EventDraft[];
}

/** Tool output kept on an event. The full transcript stays Claude's. */
export const OUTPUT_LIMIT = 2000;

export function initialTranslation(options: { resumed: boolean }): ClaudeTranslation {
  return {
    resumed: options.resumed,
    sessionStarted: false,
    configured: null,
    switched: false,
    turnId: null,
    synthetic: false,
    tools: new Map(),
  };
}

/**
 * A prompt was sent: the turn starts, and the prompt is its first item. A turn Claude started by
 * itself is closed first: what follows answers this prompt (as T3 Code does).
 */
export function startTurn(state: ClaudeTranslation, turnId: TurnId, prompt: string): Translated {
  // Note for #6: this reports Claude's own turn completed (no cost, no duration) while Claude may
  // still be running it; its remaining items and its result land on, or are ignored by, our turn.
  const closing: EventDraft[] =
    state.turnId !== null && state.synthetic
      ? [{ type: "turn.completed", turnId: state.turnId, payload: { state: "completed" } }]
      : [];
  return {
    state: { ...state, turnId, synthetic: false },
    events: [
      ...closing,
      { type: "turn.started", turnId, payload: { prompt } },
      {
        type: "item.completed",
        turnId,
        itemId: turnId,
        payload: { itemType: "user_message", status: "completed", text: prompt },
      },
    ],
  };
}

export function translate(state: ClaudeTranslation, message: SDKMessage): Translated {
  switch (message.type) {
    case "system":
      return message.subtype === "init" ? onInit(state, message) : same(state);
    case "assistant":
      return onAssistant(state, message);
    case "user":
      return "isReplay" in message && message.isReplay ? same(state) : onUser(state, message);
    case "result":
      return onResult(state, message);
    case "auth_status":
      return message.error
        ? {
            state,
            events: [
              withTurn(state, {
                type: "runtime.error",
                payload: { message: `Claude sign-in failed: ${message.error}` },
              }),
            ],
          }
        : same(state);
    default:
      // Partial messages, hooks, tasks, rate limits, …: nothing a card needs yet.
      return same(state);
  }
}

function onInit(state: ClaudeTranslation, message: SDKSystemMessage): Translated {
  const events: EventDraft[] = [];
  if (!state.sessionStarted) {
    events.push(
      withTurn(state, {
        type: "session.started",
        payload: { sessionId: message.session_id, resumed: state.resumed },
      }),
    );
  }
  let configured = state.configured;
  if (configured === null || configured.model !== message.model) {
    const reported = configured !== null && state.switched;
    configured = {
      model: message.model,
      cwd: message.cwd,
      permissionMode: message.permissionMode,
      agentVersion: message.claude_code_version,
      tools: message.tools,
      mcpServers: message.mcp_servers.map(({ name, status }) => ({ name, status })),
      skills: message.skills,
      plugins: message.plugins.map((p) => p.name),
      agents: message.agents ?? [],
    };
    if (!reported) events.push(withTurn(state, { type: "session.configured", payload: configured }));
  }
  return { state: { ...state, sessionStarted: true, configured, switched: false }, events };
}

function onAssistant(state: ClaudeTranslation, message: SDKAssistantMessage): Translated {
  const events: EventDraft[] = [];
  const parentItemId = message.parent_tool_use_id;
  let next = state;

  // Claude can start a turn by itself (a background task finishing, a resumed session catching
  // up). Give its work a turn of its own rather than pinning it on nothing.
  if (next.turnId === null && parentItemId === null) {
    const turnId = message.uuid;
    next = { ...next, turnId, synthetic: true };
    events.push({ type: "turn.started", turnId, payload: {} });
  }

  const tools = new Map(next.tools);
  message.message.content.forEach((block, index) => {
    const itemId = `${message.uuid}:${index}`;
    const parent = parentItemId ? { parentItemId } : {};
    if (block.type === "text" && block.text.trim() !== "") {
      events.push(
        withTurn(next, {
          type: "item.completed",
          itemId,
          payload: {
            itemType: "assistant_message",
            status: "completed",
            text: block.text,
            ...parent,
          },
        }),
      );
    } else if (block.type === "thinking" && block.thinking.trim() !== "") {
      events.push(
        withTurn(next, {
          type: "item.completed",
          itemId,
          payload: { itemType: "reasoning", status: "completed", text: block.thinking, ...parent },
        }),
      );
    } else if (block.type === "tool_use") {
      const input = isRecord(block.input) ? block.input : {};
      const call: ToolCall = {
        toolName: block.name,
        toolKind: toolKind(block.name),
        summary: summarizeTool(block.name, input),
        parentItemId,
      };
      tools.set(block.id, call);
      events.push(
        withTurn(next, {
          type: "item.started",
          itemId: block.id,
          payload: { ...toolPayload(call, "in_progress"), input: boundedInput(block.input) },
        }),
      );
    }
  });
  return { state: { ...next, tools }, events };
}

function onUser(state: ClaudeTranslation, message: SDKUserMessage): Translated {
  const content = message.message.content;
  if (typeof content === "string") return same(state); // our own prompt, echoed
  const events: EventDraft[] = [];
  const tools = new Map(state.tools);
  for (const block of content) {
    if (block.type !== "tool_result") continue;
    const call = tools.get(block.tool_use_id) ?? {
      toolName: "unknown",
      toolKind: "tool" as const,
      summary: "",
      parentItemId: message.parent_tool_use_id,
    };
    tools.delete(block.tool_use_id);
    const output = toolResultText(block.content);
    events.push(
      withTurn(state, {
        type: "item.completed",
        itemId: block.tool_use_id,
        payload: {
          ...toolPayload(call, block.is_error ? "failed" : "completed"),
          ...(output === "" ? {} : { output: trim(output, OUTPUT_LIMIT) }),
        },
      }),
    );
  }
  return { state: { ...state, tools }, events };
}

function onResult(state: ClaudeTranslation, message: SDKResultMessage): Translated {
  const turnId = state.turnId;
  // No turn open: the resume handshake's empty result, or a stray one. Nothing to close.
  if (turnId === null) return same(state);
  if (isForAnotherTurn(state, turnId, message)) return same(state);

  const { state: turnState, errorMessage } = outcome(message);
  const events: EventDraft[] = [];
  if (turnState === "failed") {
    events.push({
      type: "runtime.error",
      turnId,
      payload: { message: errorMessage ?? "Claude's turn failed." },
    });
  }
  events.push({
    type: "turn.completed",
    turnId,
    payload: {
      state: turnState,
      ...(message.subtype === "success" && !message.is_error && message.result !== ""
        ? { result: message.result }
        : {}),
      ...(errorMessage ? { errorMessage } : {}),
      costUsd: message.total_cost_usd,
      durationMs: message.duration_ms,
    },
  });
  // Tools still "in flight" when the turn ends never got a result (interrupted): forget them.
  return { state: { ...state, turnId: null, synthetic: false, tools: new Map() }, events };
}

/**
 * True when a result answers a turn other than the open one, so it must not close it. Claude runs
 * turns of its own between our prompts (a resumed session reporting background tasks the last
 * process left behind, a background command finishing) and our prompt waits behind them. Our
 * prompts carry the turn id as their uuid, which Claude echoes on the result; its own turns echo
 * nothing and carry a non-human `origin`. A turn Claude started itself takes any result.
 * After T3 Code's `isResultForOtherTurn`.
 */
function isForAnotherTurn(
  state: ClaudeTranslation,
  turnId: TurnId,
  message: SDKResultMessage,
): boolean {
  if (state.synthetic) return false;
  const echoed =
    message.user_message_uuids ?? (message.user_message_uuid ? [message.user_message_uuid] : []);
  if (echoed.length > 0) return !echoed.includes(turnId);
  return message.origin !== undefined && message.origin.kind !== "human";
}

function outcome(message: SDKResultMessage): { state: TurnState; errorMessage?: string } {
  const errors = (message.subtype === "success" ? [] : message.errors).filter(
    (e) => !e.startsWith("[ede_diagnostic]"),
  );
  if (
    message.terminal_reason === "aborted_tools" ||
    message.terminal_reason === "aborted_streaming" ||
    errors.some((e) => e.toLowerCase().includes("interrupt"))
  ) {
    return { state: "interrupted" };
  }
  if (message.subtype === "success") {
    return message.is_error
      ? { state: "failed", errorMessage: message.result || "Claude reported an error." }
      : { state: "completed" };
  }
  const reason = errors.join("; ") || message.subtype.replaceAll("_", " ");
  return { state: "failed", errorMessage: reason };
}

/** Which kind of tool a Claude tool name is. Unknown names are just `tool`. */
export function toolKind(name: string): ToolKind {
  if (name.startsWith("mcp__")) return "mcp";
  switch (name) {
    case "Bash":
    case "BashOutput":
    case "KillShell":
    case "KillBash":
    case "Monitor":
      return "command";
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit":
      return "file_change";
    case "Read":
    case "Grep":
    case "Glob":
    case "LS":
    case "NotebookRead":
      return "file_read";
    case "WebFetch":
    case "WebSearch":
      return "web";
    case "Agent":
    case "Task":
      return "subagent";
    default:
      return "tool";
  }
}

/** One line a person can read: "Bash: npm test", "Edit: src/app.ts". */
export function summarizeTool(name: string, input: Record<string, unknown>): string {
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
    return undefined;
  };
  const questions = Array.isArray(input.questions) ? input.questions : [];
  const firstQuestion = isRecord(questions[0]) ? questions[0].question : undefined;
  const what =
    pick(
      "command",
      "file_path",
      "notebook_path",
      "path",
      "pattern",
      "url",
      "query",
      "description",
      "headline", // Tenzo's propose
    ) ??
    (typeof firstQuestion === "string" ? firstQuestion : undefined) ??
    (Object.keys(input).length > 0 ? JSON.stringify(input) : "");
  return trim(what === "" ? name : `${name}: ${what.replaceAll(/\s+/g, " ")}`, 300);
}

/** A string field of a tool's input kept on an event; a command gets more room than the rest. */
export const INPUT_STRING_LIMIT = 300;
const COMMAND_LIMIT = 2000;
const INPUT_KEY_LIMIT = 20;

/**
 * A tool's input as copied onto an event: enough for a card (the command, the file path, a short
 * description), not a file's whole new content. Long strings are cut with a note of how much was
 * left out; a large nested value becomes its JSON, cut the same way. Claude still gets the full
 * input; this is only what Tenzo keeps.
 */
export function boundedInput(input: unknown): unknown {
  if (!isRecord(input)) return capJson(input);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input).slice(0, INPUT_KEY_LIMIT)) {
    if (typeof value === "string") {
      out[key] = cap(value, key === "command" ? COMMAND_LIMIT : INPUT_STRING_LIMIT);
    } else {
      out[key] = capJson(value);
    }
  }
  return out;
}

function capJson(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const json = JSON.stringify(value);
  return json.length <= INPUT_STRING_LIMIT ? value : cap(json, INPUT_STRING_LIMIT);
}

function cap(text: string, limit: number): string {
  return text.length <= limit
    ? text
    : `${text.slice(0, limit)}… (${text.length - limit} more characters)`;
}

function toolPayload(call: ToolCall, status: ItemPayload["status"]): ItemPayload {
  return {
    itemType: "tool",
    status,
    text: call.summary,
    toolKind: call.toolKind,
    toolName: call.toolName,
    ...(call.parentItemId ? { parentItemId: call.parentItemId } : {}),
  };
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "",
    )
    .filter((text) => text !== "")
    .join("\n");
}

function trim(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

/** Puts the open turn's id on an event that belongs to it. */
function withTurn(state: ClaudeTranslation, draft: EventDraft): EventDraft {
  return state.turnId === null ? draft : ({ ...draft, turnId: state.turnId } as EventDraft);
}

function same(state: ClaudeTranslation): Translated {
  return { state, events: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
