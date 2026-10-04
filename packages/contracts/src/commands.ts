import { z } from "zod";
import { ThinkingLevel } from "./config.ts";
import { ThreadDiff } from "./diff.ts";
import { LiveInfo } from "./finished.ts";
import { EnvironmentId } from "./ids.ts";
import { ItemAnswer, ProjectView, QueueItem, StoredEvent, ThreadView } from "./queue.ts";

/** The most events one `thread.events` or `thread.watch` answer carries. */
export const MAX_EVENT_PAGE = 500;

/**
 * What a client can ask the daemon to do. One vocabulary for every transport: the CLI posts these
 * to `POST /api/commands` now, and the WebSocket (#7) carries the same objects. Ids are plain
 * strings here so a mistyped one gets the daemon's "No thread …" rather than a schema error.
 */
export const Command = z.discriminatedUnion("type", [
  /** A new thread: worktree and branch, then the agent starts on `prompt` if one is given. */
  z.object({
    type: z.literal("thread.create"),
    project: z.string().min(1),
    /** Default: the first line of the prompt. One of `title` and `prompt` is required. */
    title: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    /** A model the agent understands, e.g. "haiku". Kept for the thread's later turns. */
    model: z.string().min(1).optional(),
    /**
     * A key the client makes up for this one request (a random id per draft) and sends again
     * when it retries. The daemon answers a key it has seen with the thread it made then, so a
     * retry after a dropped connection can't start a second thread.
     */
    clientKey: z.string().min(8).max(128).optional(),
  }),
  /** A prompt for a thread. Waits in the thread's queue while a turn is running. */
  z.object({
    type: z.literal("thread.send"),
    threadId: z.string().min(1),
    prompt: z.string().min(1),
  }),
  z.object({
    type: z.literal("thread.archive"),
    threadId: z.string().min(1),
    force: z.boolean().optional(),
  }),
  z.object({
    type: z.literal("thread.list"),
    project: z.string().min(1).optional(),
    includeArchived: z.boolean().optional(),
  }),
  /**
   * A thread's events, oldest first: after `after` (a `seq`), or the `limit` latest before
   * `before`, or both. Without `limit`, every one.
   */
  z.object({
    type: z.literal("thread.events"),
    threadId: z.string().min(1),
    after: z.number().int().nonnegative().optional(),
    before: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(MAX_EVENT_PAGE).optional(),
  }),
  /**
   * WebSocket only: follow one thread's events. The answer carries the backlog (the `limit`
   * latest events, or those after `after` when the client has the ones before), and from then
   * on the socket gets an `event` frame for each new one, in order, none missed or repeated.
   * Until `thread.unwatch` or the socket closes; a reconnected client watches again.
   */
  z.object({
    type: z.literal("thread.watch"),
    threadId: z.string().min(1),
    after: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(MAX_EVENT_PAGE).optional(),
  }),
  /** WebSocket only: stop following a thread's events. */
  z.object({ type: z.literal("thread.unwatch"), threadId: z.string().min(1) }),
  /**
   * The thread's own model and thinking level, over its project's config, in every phase from
   * now on. `model` null and no `thinking`: back to the project's config. A running session
   * switches at once where Claude can; the rest applies from its next session.
   */
  z.object({
    type: z.literal("thread.setModel"),
    threadId: z.string().min(1),
    model: z.string().trim().min(1).nullable(),
    thinking: ThinkingLevel.nullable().optional(),
  }),
  /** What the thread changed against the project's default branch: files with +/−. */
  z.object({ type: z.literal("thread.diff"), threadId: z.string().min(1) }),
  /** The projects a thread can start in, by name. */
  z.object({ type: z.literal("project.list") }),
  /** Projects, active threads and open items: everything the Pass needs to draw. */
  z.object({ type: z.literal("snapshot") }),
  z.object({
    type: z.literal("item.answer"),
    itemId: z.string().min(1),
    answer: ItemAnswer,
  }),
  /** Not now: the item leaves the Pass for a while (15 minutes) and comes back by itself. */
  z.object({ type: z.literal("item.snooze"), itemId: z.string().min(1) }),
  /** Brings a snoozed item back now (Undo). An item that is awake already stays as it is. */
  z.object({ type: z.literal("item.unsnooze"), itemId: z.string().min(1) }),
]);
export type Command = z.infer<typeof Command>;
export type CommandType = Command["type"];

export const Snapshot = z.object({
  environmentId: EnvironmentId,
  threads: z.array(ThreadView),
  /** Open items, oldest first. */
  items: z.array(QueueItem),
  /** Registered projects, by name. Projects added later come with `project.list`. */
  projects: z.array(ProjectView).default([]),
  /** Where threads' live apps are served (Open live); null when this daemon serves none. */
  live: LiveInfo.nullable().default(null),
});
export type Snapshot = z.infer<typeof Snapshot>;

/** What each command answers with. */
export const CommandResults = {
  "thread.create": z.object({ thread: ThreadView }),
  "thread.send": z.object({ thread: ThreadView }),
  "thread.archive": z.object({ thread: ThreadView }),
  "thread.setModel": z.object({ thread: ThreadView }),
  "thread.list": z.object({ threads: z.array(ThreadView) }),
  "thread.events": z.object({
    thread: ThreadView,
    events: z.array(StoredEvent),
    /** There are earlier events than the first one here (with `limit`). */
    older: z.boolean().default(false),
  }),
  "thread.watch": z.object({
    thread: ThreadView,
    /** The backlog, oldest first. */
    events: z.array(StoredEvent),
    /** There are earlier events than the backlog's first: `thread.events` with `before` pages them. */
    older: z.boolean(),
    /**
     * The backlog replaces what the client had: no `after` was given, or more than `limit` events
     * came after it. False: the backlog follows on from `after` with nothing missing.
     */
    reset: z.boolean(),
  }),
  "thread.unwatch": z.object({ watching: z.literal(false) }),
  "thread.diff": ThreadDiff,
  "project.list": z.object({ projects: z.array(ProjectView) }),
  snapshot: Snapshot,
  "item.answer": z.object({
    item: QueueItem,
    /**
     * `live`: the agent was still waiting and got the answer directly. `message`: the agent that
     * asked had stopped, or nothing waits on the item (an error, finished work, a ready PR), so
     * the answer goes to it as its next prompt.
     * `none`: nothing goes to the agent (finished work marked done, a config card retried).
     * `archived`: an error item answered with Archive; the thread is gone.
     */
    delivery: z.enum(["live", "message", "none", "archived"]),
    thread: ThreadView,
  }),
  "item.snooze": z.object({ item: QueueItem, thread: ThreadView }),
  "item.unsnooze": z.object({ item: QueueItem, thread: ThreadView }),
} satisfies Record<CommandType, z.ZodType>;
export type CommandResult<T extends CommandType> = z.infer<(typeof CommandResults)[T]>;

/** The body of every `POST /api/commands` response. */
export const CommandResponse = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type CommandResponse = z.infer<typeof CommandResponse>;
