import { z } from "zod";
import { EnvironmentId, ProjectId, ThreadId } from "./ids.ts";
import {
  AgentKind,
  RequestId,
  RuntimeEvent,
  ToolKind,
  TurnId,
  UserInputAnswers,
  UserInputOption,
  UserInputQuestion,
} from "./runtime.ts";

/**
 * The attention queue: what a thread needs from you. PRODUCT.md calls these *items*; in code they
 * are queue items, because the runtime events already use "item" for messages and tool calls
 * (after T3 Code). The daemon folds runtime events into them (#6); the Pass shows them (#8).
 */

export const QueueItemId = z.string().regex(/^itm_[a-z0-9]{20}$/);
export type QueueItemId = z.infer<typeof QueueItemId>;

/** Quick: the agent is stuck waiting on you. Review: finished work waiting for a look (M2). */
export const Lane = z.enum(["quick", "review"]);
export type Lane = z.infer<typeof Lane>;

export const QueueItemKind = z.enum(["question", "permission"]);
export type QueueItemKind = z.infer<typeof QueueItemKind>;

/** How an item left the queue. */
export const QueueItemResolution = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answered"), answers: UserInputAnswers }),
  z.object({ kind: z.literal("allowed") }),
  z.object({ kind: z.literal("denied"), message: z.string().optional() }),
  /** The agent withdrew it: the turn was interrupted. */
  z.object({ kind: z.literal("cancelled") }),
  /** Its thread was archived. */
  z.object({ kind: z.literal("dismissed") }),
]);
export type QueueItemResolution = z.infer<typeof QueueItemResolution>;

export const QueueItem = z.object({
  id: QueueItemId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  lane: Lane,
  kind: QueueItemKind,
  /** The agent's pending request this item answers. One item per request. */
  requestId: RequestId,
  turnId: TurnId.optional(),
  /** What the agent said last before asking, trimmed to a couple of lines. May be empty. */
  context: z.string(),
  /** The question, or for a permission request what the agent wants to do. */
  ask: z.string(),
  /** The answers to offer as buttons. For a permission request: Allow, Deny. */
  options: z.array(UserInputOption),
  /** The option `value` to put on the filled button, when there is one. */
  suggested: z.string().nullable(),
  /** A question item: every question of the ask, in order (`ask` and `options` are the first). */
  questions: z.array(UserInputQuestion),
  /** A permission item: the tool the agent wants to use. */
  permission: z
    .object({
      toolKind: ToolKind,
      toolName: z.string(),
      detail: z.string(),
      reason: z.string().optional(),
      input: z.unknown(),
    })
    .optional(),
  createdAt: z.iso.datetime(),
  status: z.enum(["open", "resolved"]),
  /**
   * The agent process that asked has ended (a crash, a daemon restart) so nothing is waiting on
   * the request any more. Answering still works: the daemon resumes the agent's session and
   * tells it what was asked and what you chose.
   */
  detached: z.boolean(),
  resolvedAt: z.iso.datetime().nullable(),
  resolution: QueueItemResolution.nullable(),
});
export type QueueItem = z.infer<typeof QueueItem>;

/** An answer to an item: one per question, or a permission decision. */
export const ItemAnswer = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("question"),
    /** Question id → an option's `value`, several joined by ", ", or free text. */
    answers: UserInputAnswers,
  }),
  z.object({
    kind: z.literal("permission"),
    decision: z.enum(["allow", "deny"]),
    /** Goes back to the agent with a deny: why not, or what to do instead. */
    message: z.string().optional(),
  }),
]);
export type ItemAnswer = z.infer<typeof ItemAnswer>;

/** What a thread is doing, for lists and for the CLI to know when to stop following it. */
export const ThreadActivity = z.enum(["idle", "working", "needs-you"]);
export type ThreadActivity = z.infer<typeof ThreadActivity>;

export const ThreadView = z.object({
  id: ThreadId,
  environmentId: EnvironmentId,
  projectId: ProjectId,
  projectName: z.string(),
  title: z.string(),
  branch: z.string(),
  worktreePath: z.string(),
  status: z.enum(["active", "archived"]),
  agent: AgentKind.nullable(),
  model: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
  /** `needs-you` when it has an open item, else `working` while a turn runs or prompts wait. */
  activity: ThreadActivity,
  /** A turn is running or a prompt is waiting to be sent. */
  working: z.boolean(),
  /** Prompts waiting for the running turn to end. */
  queued: z.number().int().nonnegative(),
  openItems: z.number().int().nonnegative(),
  /** The sequence number of the thread's latest event, 0 before the first. */
  lastSeq: z.number().int().nonnegative(),
});
export type ThreadView = z.infer<typeof ThreadView>;

/** A runtime event as the daemon stored it: its place in the log and the machine it came from. */
export const StoredEvent = z.object({
  seq: z.number().int().positive(),
  environmentId: EnvironmentId,
  event: RuntimeEvent,
});
export type StoredEvent = z.infer<typeof StoredEvent>;
