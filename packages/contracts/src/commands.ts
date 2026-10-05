import { z } from "zod";
import { AutomationProblem, AutomationRunView, AutomationsState, AutomationView } from "./automations.ts";
import { ModelName, ThinkingLevel } from "./config.ts";
import { Device, DeviceId, DeviceName } from "./devices.ts";
import { ThreadDiff } from "./diff.ts";
import { LiveInfo } from "./finished.ts";
import { EnvironmentId, ThreadId } from "./ids.ts";
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
    model: ModelName.optional(),
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
   * now on. `model` null: the project's config decides the model again. `thinking` null: the
   * same for thinking; left out: the thread's thinking stays as it is. A running session
   * switches at once where Claude can, else at its next turn (engine.ts).
   */
  z.object({
    type: z.literal("thread.setModel"),
    threadId: z.string().min(1),
    model: ModelName.nullable(),
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
  /** The automations the projects' configs define (all projects, or one). */
  z.object({ type: z.literal("automation.list"), project: z.string().min(1).optional() }),
  /**
   * Runs an automation now (Run now): an ordinary thread on its prompt, unless its previous run
   * is still going (then the run is recorded as skipped).
   */
  z.object({
    type: z.literal("automation.run"),
    project: z.string().min(1),
    name: z.string().min(1).max(100),
  }),
  /**
   * The off switch, kept in Tenzo's home (never in a repo): `paused` true, no schedule starts a
   * run (running one by hand still does) until it is false again.
   */
  z.object({ type: z.literal("automation.pause"), paused: z.boolean() }),
  /**
   * Archives the automation's finished runs (nothing running or queued, nothing open but
   * finished work) whose worktree is clean; their branches are kept. A run that waits on you,
   * is still going, or has uncommitted changes stays.
   */
  z.object({
    type: z.literal("automation.archiveFinished"),
    project: z.string().min(1),
    name: z.string().min(1).max(100),
  }),
  /**
   * A one-time pairing link's code (`tenzo pair`): short-lived, single use. Only from the Mac
   * itself; a paired device can't make more.
   */
  z.object({ type: z.literal("device.pair"), name: DeviceName.optional() }),
  /** The paired devices, and which one is asking (none on the Mac itself). */
  z.object({ type: z.literal("device.list") }),
  z.object({ type: z.literal("device.rename"), deviceId: z.string().min(1), name: DeviceName }),
  /** Unpairs a device: its token stops working and its connections close at once. */
  z.object({ type: z.literal("device.revoke"), deviceId: z.string().min(1) }),
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
  /** The projects' automations, by project and name: next run and last run. */
  automations: z.array(AutomationView).default([]),
  /** The off switch (`automation.pause`): no schedule starts a run while it is on. */
  automationsPaused: z.boolean().default(false),
  /** Projects whose config can't be read, so their automations don't run. */
  automationProblems: z.array(AutomationProblem).default([]),
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
  "automation.list": AutomationsState,
  "automation.pause": z.object({ paused: z.boolean() }),
  "automation.run": z.object({
    automation: AutomationView,
    run: AutomationRunView,
    /** The run's thread; null when it was skipped. */
    thread: ThreadView.nullable(),
  }),
  "automation.archiveFinished": z.object({
    /** The runs archived (their branches kept). */
    archived: z.array(ThreadView),
    /** Finished runs left as they were, and why (uncommitted changes, say). */
    kept: z.array(z.object({ threadId: ThreadId, reason: z.string() })),
  }),
  "device.pair": z.object({
    /** Goes in the link's fragment (`pairingUrl`); the daemon keeps only its hash. */
    code: z.string(),
    expiresAt: z.string(),
    /** Where devices reach this daemon (`TENZO_PUBLIC_URL`), for the link; null: it wasn't told. */
    origin: z.string().nullable(),
  }),
  "device.list": z.object({
    devices: z.array(Device),
    /** The device asking; null on the Mac itself. */
    current: DeviceId.nullable(),
  }),
  "device.rename": z.object({ device: Device }),
  "device.revoke": z.object({ device: Device }),
} satisfies Record<CommandType, z.ZodType>;
export type CommandResult<T extends CommandType> = z.infer<(typeof CommandResults)[T]>;

/** The body of every `POST /api/commands` response. */
export const CommandResponse = z.union([
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);
export type CommandResponse = z.infer<typeof CommandResponse>;
