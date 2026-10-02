import { z } from "zod";
import { ThreadId } from "./ids.ts";

/**
 * Tenzo's agent event vocabulary: what an agent adapter (Claude now, Codex in M5) reports about a
 * running thread, normalized so nothing above the adapter knows which agent it is. Small on
 * purpose; shaped after T3 Code's `providerRuntime.ts`. The event store (#6) persists these, and
 * the Pass (#8) turns `user-input.requested` and `request.opened` into cards.
 */

/** One event, unique across the machine. */
export const EventId = z.string().regex(/^evt_[a-z0-9]{20}$/);
export type EventId = z.infer<typeof EventId>;

/** One prompt and everything the agent did about it. A UUID: Claude echoes it back on its replies. */
export const TurnId = z.uuid();
export type TurnId = z.infer<typeof TurnId>;

/** A message, a tool call, a reasoning block. For tools, the agent's own tool-use id. */
export const ItemId = z.string().min(1);
export type ItemId = z.infer<typeof ItemId>;

/** A pending question or permission request that waits for an answer. */
export const RequestId = z.string().regex(/^req_[a-z0-9]{20}$/);
export type RequestId = z.infer<typeof RequestId>;

export const AgentKind = z.enum(["claude", "codex"]);
export type AgentKind = z.infer<typeof AgentKind>;

/** What a tool does, as far as a card needs to know. Shared by tool items and permission requests. */
export const ToolKind = z.enum([
  "command", // Bash and friends
  "file_change", // Edit, Write, NotebookEdit
  "file_read", // Read, Grep, Glob
  "web", // WebFetch, WebSearch
  "mcp", // a tool from an MCP server
  "subagent", // Agent / Task
  "tool", // anything else
]);
export type ToolKind = z.infer<typeof ToolKind>;

export const ItemType = z.enum(["user_message", "assistant_message", "reasoning", "tool"]);
export type ItemType = z.infer<typeof ItemType>;

export const ItemStatus = z.enum(["in_progress", "completed", "failed"]);
export type ItemStatus = z.infer<typeof ItemStatus>;

export const TurnState = z.enum(["completed", "failed", "interrupted"]);
export type TurnState = z.infer<typeof TurnState>;

/** How a permission request was answered. `deny` may carry a note that goes back to the agent. */
export const RequestDecision = z.enum(["allow", "deny", "cancel"]);
export type RequestDecision = z.infer<typeof RequestDecision>;

export const UserInputOption = z.object({
  label: z.string(),
  description: z.string(),
  /** The agent's suggested answer: the card's filled button. */
  recommended: z.boolean(),
  /** Content to show while the option is focused (a mockup, a snippet), when the agent gave one. */
  preview: z.string().optional(),
});
export type UserInputOption = z.infer<typeof UserInputOption>;

export const UserInputQuestion = z.object({
  /** The key its answer goes under. For Claude this is the question text itself. */
  id: z.string().min(1),
  /** A short chip, e.g. "Auth method". */
  header: z.string(),
  question: z.string(),
  options: z.array(UserInputOption),
  multiSelect: z.boolean(),
});
export type UserInputQuestion = z.infer<typeof UserInputQuestion>;

/** Question id → the answer: an option label, several joined by ", ", or free text. */
export const UserInputAnswers = z.record(z.string(), z.string());
export type UserInputAnswers = z.infer<typeof UserInputAnswers>;

const base = {
  eventId: EventId,
  threadId: ThreadId,
  agent: AgentKind,
  createdAt: z.iso.datetime(),
  turnId: TurnId.optional(),
};

const ItemPayload = z.object({
  itemType: ItemType,
  status: ItemStatus,
  /** Message text, reasoning text, or for a tool a one-line summary ("Bash: ls -la"). */
  text: z.string().optional(),
  toolKind: ToolKind.optional(),
  toolName: z.string().optional(),
  input: z.unknown().optional(),
  /** Tool output, trimmed. The full transcript stays the agent's. */
  output: z.string().optional(),
  /** Set when the item ran inside a subagent: the tool-use id of the subagent call. */
  parentItemId: ItemId.optional(),
});
export type ItemPayload = z.infer<typeof ItemPayload>;

export const RuntimeEvent = z.discriminatedUnion("type", [
  /** The agent process is up. `sessionId` is the agent's own id; store it to resume. */
  z.object({
    ...base,
    type: z.literal("session.started"),
    payload: z.object({
      sessionId: z.string().min(1),
      resumed: z.boolean(),
    }),
  }),
  /** What the agent loaded: model, tools, skills, MCP servers, plugins (#5 checks these). */
  z.object({
    ...base,
    type: z.literal("session.configured"),
    payload: z.object({
      model: z.string(),
      cwd: z.string(),
      permissionMode: z.string(),
      agentVersion: z.string(),
      tools: z.array(z.string()),
      mcpServers: z.array(z.object({ name: z.string(), status: z.string() })),
      skills: z.array(z.string()),
      plugins: z.array(z.string()),
      agents: z.array(z.string()),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("session.exited"),
    payload: z.object({
      exitKind: z.enum(["graceful", "error"]),
      reason: z.string().optional(),
    }),
  }),
  z.object({
    ...base,
    turnId: TurnId,
    type: z.literal("turn.started"),
    payload: z.object({ prompt: z.string().optional() }),
  }),
  z.object({
    ...base,
    turnId: TurnId,
    type: z.literal("turn.completed"),
    payload: z.object({
      state: TurnState,
      /** The agent's final answer for the turn, when it gave one. */
      result: z.string().optional(),
      errorMessage: z.string().optional(),
      costUsd: z.number().optional(),
      durationMs: z.number().optional(),
    }),
  }),
  z.object({ ...base, itemId: ItemId, type: z.literal("item.started"), payload: ItemPayload }),
  z.object({ ...base, itemId: ItemId, type: z.literal("item.completed"), payload: ItemPayload }),
  /** The agent wants to run a tool that needs your permission. Answer allow or deny. */
  z.object({
    ...base,
    requestId: RequestId,
    type: z.literal("request.opened"),
    payload: z.object({
      toolKind: ToolKind,
      toolName: z.string(),
      /** One line: "Bash: rm -rf build". */
      detail: z.string(),
      /** The agent's own sentence for the ask, when it gave one. */
      title: z.string().optional(),
      /** Why it is asking, when the agent says (e.g. a path outside the worktree). */
      reason: z.string().optional(),
      input: z.unknown(),
      itemId: ItemId.optional(),
    }),
  }),
  z.object({
    ...base,
    requestId: RequestId,
    type: z.literal("request.resolved"),
    payload: z.object({
      decision: RequestDecision,
      message: z.string().optional(),
    }),
  }),
  /** The agent asked you something, with options. Answer each question. */
  z.object({
    ...base,
    requestId: RequestId,
    type: z.literal("user-input.requested"),
    payload: z.object({
      questions: z.array(UserInputQuestion),
      itemId: ItemId.optional(),
    }),
  }),
  z.object({
    ...base,
    requestId: RequestId,
    type: z.literal("user-input.resolved"),
    payload: z.object({
      /** Empty when the question was cancelled (turn interrupted, session stopped). */
      answers: UserInputAnswers,
      cancelled: z.boolean(),
    }),
  }),
  z.object({
    ...base,
    type: z.literal("runtime.error"),
    payload: z.object({
      message: z.string(),
      detail: z.unknown().optional(),
    }),
  }),
]);
export type RuntimeEvent = z.infer<typeof RuntimeEvent>;
export type RuntimeEventType = RuntimeEvent["type"];
/** One event of the given type. */
export type RuntimeEventOf<T extends RuntimeEventType> = Extract<RuntimeEvent, { type: T }>;
