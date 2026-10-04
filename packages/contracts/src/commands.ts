import { z } from "zod";
import { EnvironmentId } from "./ids.ts";
import { ItemAnswer, ProjectView, QueueItem, StoredEvent, ThreadView } from "./queue.ts";

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
  /** A thread's events after `after` (a `seq`), oldest first. */
  z.object({
    type: z.literal("thread.events"),
    threadId: z.string().min(1),
    after: z.number().int().nonnegative().optional(),
  }),
  /** The projects a thread can start in, by name. */
  z.object({ type: z.literal("project.list") }),
  /** Projects, active threads and open items: everything the Pass needs to draw. */
  z.object({ type: z.literal("snapshot") }),
  z.object({
    type: z.literal("item.answer"),
    itemId: z.string().min(1),
    answer: ItemAnswer,
  }),
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
});
export type Snapshot = z.infer<typeof Snapshot>;

/** What each command answers with. */
export const CommandResults = {
  "thread.create": z.object({ thread: ThreadView }),
  "thread.send": z.object({ thread: ThreadView }),
  "thread.archive": z.object({ thread: ThreadView }),
  "thread.list": z.object({ threads: z.array(ThreadView) }),
  "thread.events": z.object({ thread: ThreadView, events: z.array(StoredEvent) }),
  "project.list": z.object({ projects: z.array(ProjectView) }),
  snapshot: Snapshot,
  "item.answer": z.object({
    item: QueueItem,
    /**
     * `live`: the agent was still waiting and got the answer directly. `message`: the agent that
     * asked had stopped, so the answer goes to it as a message when its session resumes.
     */
    delivery: z.enum(["live", "message"]),
    thread: ThreadView,
  }),
} satisfies Record<CommandType, z.ZodType>;
export type CommandResult<T extends CommandType> = z.infer<(typeof CommandResults)[T]>;

/** The body of every `POST /api/commands` response. */
export const CommandResponse = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type CommandResponse = z.infer<typeof CommandResponse>;
