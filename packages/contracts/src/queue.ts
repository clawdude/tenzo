import { z } from "zod";
import { Finished } from "./finished.ts";
import { EnvironmentId, ProjectId, ThreadId } from "./ids.ts";
import {
  AgentKind,
  Fingerprint,
  MergeDecision,
  RequestId,
  ReviewDecision,
  RuntimeEvent,
  ToolKind,
  TurnId,
  UserInputAnswers,
  UserInputOption,
  UserInputQuestion,
  WebUrl,
} from "./runtime.ts";

/**
 * The attention queue: what a thread needs from you. PRODUCT.md calls these *items*; in code they
 * are queue items, because the runtime events already use "item" for messages and tool calls
 * (after T3 Code). The daemon folds runtime events into them (#6); the Pass shows them (#8).
 */

export const QueueItemId = z.string().regex(/^itm_[a-z0-9]{20}$/);
export type QueueItemId = z.infer<typeof QueueItemId>;

/** Quick: the agent is stuck waiting on you. Review: finished work waiting for a look. */
export const Lane = z.enum(["quick", "review"]);
export type Lane = z.infer<typeof Lane>;

/** `ready`: a PR the agent opened can merge (after Open PR); Merge, or say what first. */
export const QueueItemKind = z.enum(["question", "permission", "proposal", "finished", "ready"]);
export type QueueItemKind = z.infer<typeof QueueItemKind>;

/** How an item left the queue. */
export const QueueItemResolution = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answered"), answers: UserInputAnswers }),
  z.object({ kind: z.literal("allowed") }),
  z.object({ kind: z.literal("denied"), message: z.string().optional() }),
  /** A proposal you said to build. */
  z.object({ kind: z.literal("approved") }),
  /** A proposal you sent back with a note: what to change. */
  z.object({ kind: z.literal("revise"), note: z.string() }),
  /** The agent withdrew it: the turn was interrupted. */
  z.object({ kind: z.literal("cancelled") }),
  /** Its thread was archived (`thread.archived`). */
  z.object({ kind: z.literal("dismissed") }),
  /** Finished work you marked done. */
  z.object({ kind: z.literal("done") }),
  /** Finished work, or a ready PR, you said to merge: the agent lands it. */
  z.object({ kind: z.literal("merge") }),
  /** Finished work you said to open a PR for: the thread is landing. */
  z.object({ kind: z.literal("pr") }),
  /** Finished work, or a ready PR, sent back with a note: what needs changing first. */
  z.object({ kind: z.literal("changes"), note: z.string() }),
  /** Finished work the agent reported again: the newer report replaces it. */
  z.object({ kind: z.literal("superseded") }),
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
  /** The question; for a permission request what the agent wants to do; a proposal's headline. */
  ask: z.string(),
  /** The answers to offer as buttons. For a permission request: Allow, Deny; a proposal: Build it. */
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
  /** A proposal item: what the agent is going to do. `ask` is the headline. */
  proposal: z.object({ headline: z.string(), summary: z.string() }).optional(),
  /** A finished item (review lane): the handoff note, checks, screenshots and live URL. */
  finished: Finished.optional(),
  /** A ready item (quick lane): the PR and its state. `ask` is the headline. */
  ready: z.object({ url: WebUrl, summary: z.string() }).optional(),
  /** The request's fingerprint, when the agent gave one: what "the same ask again" means. */
  fingerprint: Fingerprint.optional(),
  createdAt: z.iso.datetime(),
  status: z.enum(["open", "resolved"]),
  /**
   * The agent process that asked has ended (a crash, a daemon restart) so nothing is waiting on
   * the request any more. Answering still works: the daemon resumes the agent's session and
   * tells it what was asked and what you chose. Never set on finished work: nothing waits on a
   * report.
   */
  detached: z.boolean(),
  resolvedAt: z.iso.datetime().nullable(),
  resolution: QueueItemResolution.nullable(),
});
export type QueueItem = z.infer<typeof QueueItem>;

/** An answer to an item: one per question, a permission decision, or a proposal's. */
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
  z.object({
    kind: z.literal("proposal"),
    /** Build it, or change something: then `note` says what, and the agent proposes again. */
    decision: z.enum(["build", "change"]),
    note: z.string().optional(),
  }),
  z.object({
    kind: z.literal("finished"),
    decision: ReviewDecision,
    /** Needs changes: what to change. */
    note: z.string().optional(),
  }),
  z.object({
    kind: z.literal("ready"),
    /** Merge it, or not yet: then `note` says what first. */
    decision: MergeDecision,
    note: z.string().optional(),
  }),
]);
export type ItemAnswer = z.infer<typeof ItemAnswer>;

/**
 * Where a thread is in its flow (PRODUCT.md §4). It starts `discussing`: the agent reads, asks
 * and proposes, and changes nothing. *Build it* on its proposal makes it `building`. The agent's
 * `report` makes it `review`: finished work waits for you. Merge or Open PR makes it `landing`:
 * pushed and waiting on the outside world (CI, reviewers); Needs changes, `building` again. A
 * landed thread is archived.
 */
export const ThreadPhase = z.enum(["discussing", "building", "review", "landing"]);
export type ThreadPhase = z.infer<typeof ThreadPhase>;

/** Who started a thread: you, or another thread's agent (`start_thread`). */
export const ThreadOrigin = z.enum(["user", "agent"]);
export type ThreadOrigin = z.infer<typeof ThreadOrigin>;

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
  phase: ThreadPhase,
  origin: ThreadOrigin.default("user"),
  /** The thread whose agent started this one (origin `agent`). */
  parentId: ThreadId.nullable().default(null),
  /** When the agent asked to be woken next (`wake_me`); null when it didn't. */
  wakeAt: z.iso.datetime().nullable().default(null),
  /** `needs-you` when it has an open item, else `working` while a turn runs or prompts wait. */
  activity: ThreadActivity,
  /** A turn is running or a prompt is waiting to be sent. */
  working: z.boolean(),
  /** Prompts waiting for the running turn to end. */
  queued: z.number().int().nonnegative(),
  openItems: z.number().int().nonnegative(),
  /** The sequence number of the thread's latest event, 0 before the first. */
  lastSeq: z.number().int().nonnegative(),
  /** When the thread's latest event happened; when it was created, before the first. */
  activeAt: z.iso.datetime(),
});
export type ThreadView = z.infer<typeof ThreadView>;

/** A project as clients see it: what New thread offers to start a thread in. */
export const ProjectView = z.object({
  id: ProjectId,
  environmentId: EnvironmentId,
  /** Short and unique: what `thread.create` takes as `project`. */
  name: z.string(),
  defaultBranch: z.string(),
});
export type ProjectView = z.infer<typeof ProjectView>;

/** A runtime event as the daemon stored it: its place in the log and the machine it came from. */
export const StoredEvent = z.object({
  seq: z.number().int().positive(),
  environmentId: EnvironmentId,
  event: RuntimeEvent,
});
export type StoredEvent = z.infer<typeof StoredEvent>;
