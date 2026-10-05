import { z } from "zod";
import { LandingRule, ThinkingLevel } from "./config.ts";
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

/**
 * Quick: the agent is stuck waiting on you (a question, a permission, a proposal, an error).
 * Review: finished work waiting for a look. The quick lane always comes first on the Pass.
 */
export const Lane = z.enum(["quick", "review"]);
export type Lane = z.infer<typeof Lane>;

/**
 * `finished`: work the agent reported (review lane). `error`: a turn failed, or the agent
 * crashed mid-turn; the daemon makes these from the log, no agent asked. Retry, tell it
 * something, or archive the thread. `ready`: a PR the agent opened can merge (after Open PR);
 * Merge, or say what first.
 */
export const QueueItemKind = z.enum([
  "question",
  "permission",
  "proposal",
  "finished",
  "error",
  "ready",
]);
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
  /** An error you said to retry: what failed went again. */
  z.object({ kind: z.literal("retried") }),
  /** An error you answered with words: they went to the agent as a prompt. */
  z.object({ kind: z.literal("told"), text: z.string() }),
  /** An error that cleared by itself: the thread's next turn started. */
  z.object({ kind: z.literal("recovered") }),
  /** A config card you dismissed: it stays away until what is wrong changes. */
  z.object({ kind: z.literal("acknowledged") }),
]);
export type QueueItemResolution = z.infer<typeof QueueItemResolution>;

/** What an error item knows about what went wrong. */
export const ItemError = z.object({
  /**
   * `turn`: the turn ended failed. `crash`: the agent stopped mid-turn. `start`: it never started.
   * `stalled`: a landing turn ended with nothing on the Pass and no wake. `unarchived`: the agent
   * said it landed, but the thread couldn't be archived (`landing.stuck`, engine.ts). `config`:
   * the project's `.tenzo/` config is invalid, so the thread runs on the defaults
   * (`config.checked`); Retry reads it again. `budget`: an automation's run reached its budget
   * and is paused (`budget.exceeded`); Retry is Continue, with as much budget again.
   */
  cause: z.enum(["turn", "crash", "start", "stalled", "unarchived", "config", "budget"]),
  /** The agent's or the daemon's own words for it, cut to size. */
  message: z.string(),
  /**
   * What Retry sends, in order: the failed turn's prompt, the prompts never sent, or for a
   * landing card what to tell the agent.
   */
  prompts: z.array(z.string()),
});
export type ItemError = z.infer<typeof ItemError>;

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
  /** An error item: what went wrong (`ask` says it in a few words), and what Retry sends. */
  error: ItemError.optional(),
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
  /**
   * Swiped away until then (the daemon's clock): it is off the Pass, and its thread doesn't need
   * you meanwhile. The daemon wakes it at that time (`item.unsnoozed`, which sets this back to
   * null), so set means snoozed, whatever a client's clock says. Null: awake.
   */
  snoozedUntil: z.iso.datetime().nullable().default(null),
});
export type QueueItem = z.infer<typeof QueueItem>;

/**
 * True while `item` is snoozed. The daemon decides: it wakes items on time, and a client that
 * missed that frame gets a fresh snapshot when it reconnects. A client's own clock may be minutes
 * off, so it only ever counts down to `snoozedUntil`, never decides by it.
 */
export function isSnoozed(item: Pick<QueueItem, "snoozedUntil">): boolean {
  return item.snoozedUntil !== null;
}

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
  z.object({
    kind: z.literal("error"),
    /**
     * Send what failed again; send `text` instead (tell it something); archive the thread. A
     * config card takes only retry (read the config again) and dismiss (it stays away until the
     * problem changes).
     */
    action: z.enum(["retry", "tell", "archive", "dismiss"]),
    text: z.string().optional(),
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

/**
 * Who started a thread: you, another thread's agent (`start_thread`), or an automation (its
 * schedule, or you running it by hand: `ThreadView.automation` names it).
 */
export const ThreadOrigin = z.enum(["user", "agent", "automation"]);
export type ThreadOrigin = z.infer<typeof ThreadOrigin>;

/** What a thread is doing, for lists and for the CLI to know when to stop following it. */
export const ThreadActivity = z.enum(["idle", "working", "needs-you", "snoozed"]);
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
  /**
   * The thread's own model, over its project's config (`thread.setModel`, or `--model` when it
   * was started); null: the project's config decides, else `TENZO_DEFAULT_MODEL`, else the agent.
   */
  model: z.string().nullable(),
  /** The thread's own thinking level, over its project's config; null: the config decides. */
  thinking: ThinkingLevel.nullable().default(null),
  /** The project's landing rule (`.tenzo/config.json`): the finished card's filled button. */
  landing: LandingRule.default("merge"),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  archivedAt: z.iso.datetime().nullable(),
  phase: ThreadPhase,
  origin: ThreadOrigin.default("user"),
  /** The thread whose agent started this one (origin `agent`). */
  parentId: ThreadId.nullable().default(null),
  /** The automation this thread is a run of (origin `automation`). */
  automation: z.string().nullable().default(null),
  /** When the agent asked to be woken next (`wake_me`); null when it didn't. */
  wakeAt: z.iso.datetime().nullable().default(null),
  /**
   * `needs-you` when it has an open item that isn't snoozed; `snoozed` when it has open items and
   * all of them are (it waits on you, later); else `working` while a turn runs or prompts wait.
   */
  activity: ThreadActivity,
  /** A turn is running or a prompt is waiting to be sent. */
  working: z.boolean(),
  /** Prompts waiting for the running turn to end. */
  queued: z.number().int().nonnegative(),
  /** Open items, snoozed ones included. */
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
