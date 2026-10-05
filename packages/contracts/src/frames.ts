import { z } from "zod";
import { AutomationsState } from "./automations.ts";
import { Command, Snapshot } from "./commands.ts";
import { LiveInfo } from "./finished.ts";
import { EnvironmentId } from "./ids.ts";
import { QueueItem, StoredEvent, ThreadView } from "./queue.ts";

/**
 * The WebSocket protocol, `/ws`. One socket carries both directions:
 *
 * - the daemon says `hello`, then sends a `snapshot` (active threads, open items), then streams
 *   a `thread` frame whenever a thread changes and an `item` frame whenever an item opens,
 *   detaches, is snoozed or wakes, or resolves, and an `automations` frame whenever an automation's
 *   next run, last run or finished runs change, the off switch flips, or a config breaks or
 *   heals; a client that applies them in order has what the daemon has;
 * - a client that watches a thread (`thread.watch`) also gets an `event` frame for each of that
 *   thread's new events, after the watch's answer and in the log's order;
 * - the client sends `command` frames, each with an id of its choosing, and the daemon answers
 *   each with `ok` or `error` carrying that id; commands are the same vocabulary as
 *   `POST /api/commands` and run through the same code;
 * - the client sends `ping` now and then and the daemon answers `pong`, so either side notices a
 *   dead connection (phones and tailnets drop sockets without closing them);
 * - the client says whether its page is in view (`visibility`), on connecting and whenever that
 *   changes: a paired device looking at Tenzo gets no push for what it can already see.
 *
 * Every frame is JSON text, validated against these schemas on arrival at either end.
 */

/** A client's name for one command, echoed on its answer. */
export const RequestFrameId = z.string().min(1).max(64);

// Frames the daemon sends.

export const ServerHello = z.object({
  type: z.literal("hello"),
  environmentId: EnvironmentId,
  version: z.string(),
  serverTime: z.string(),
});
export const ServerPong = z.object({
  type: z.literal("pong"),
  at: z.string(),
});
/** Everything the Pass needs to draw. Replaces whatever the client had. */
export const ServerSnapshot = z.object({
  type: z.literal("snapshot"),
  snapshot: Snapshot,
});
/** A thread as it is now. An archived one leaves the client's list. */
export const ServerThread = z.object({
  type: z.literal("thread"),
  thread: ThreadView,
});
/**
 * An item opened, changed (an error card that still holds), detached (its agent ended), was
 * snoozed or woke up, or resolved; `item` is how it is now.
 */
export const ServerItem = z.object({
  type: z.literal("item"),
  change: z.enum(["opened", "updated", "detached", "snoozed", "unsnoozed", "resolved"]),
  item: QueueItem,
});
/**
 * The automations as they are now (the snapshot's `automations`, `automationsPaused` and
 * `automationProblems`), whole: it replaces what the client had.
 */
export const ServerAutomations = AutomationsState.extend({
  type: z.literal("automations"),
});
/**
 * Where threads' live apps are, again: sent now and then to a paired device so its Open live
 * grant (`LiveInfo.grant`, short-lived) never runs out while the socket stays open.
 */
export const ServerLive = z.object({
  type: z.literal("live"),
  live: LiveInfo,
});
/** One new event of a thread this socket watches (`thread.watch`). */
export const ServerEvent = z.object({
  type: z.literal("event"),
  event: StoredEvent,
});
/** A command ran. `result` has the shape `CommandResults[type]` for the command's type. */
export const ServerOk = z.object({
  type: z.literal("ok"),
  id: RequestFrameId,
  result: z.unknown(),
});
/**
 * A command failed, or a frame was not understood. `id` is the command's when the daemon could
 * read one, else null.
 */
export const ServerError = z.object({
  type: z.literal("error"),
  id: RequestFrameId.nullable(),
  error: z.string(),
});

export const ServerFrame = z.discriminatedUnion("type", [
  ServerHello,
  ServerPong,
  ServerSnapshot,
  ServerThread,
  ServerItem,
  ServerAutomations,
  ServerLive,
  ServerEvent,
  ServerOk,
  ServerError,
]);
export type ServerFrame = z.infer<typeof ServerFrame>;

// Frames a client sends.

export const ClientPing = z.object({
  type: z.literal("ping"),
  at: z.string(),
});
export const ClientCommand = z.object({
  type: z.literal("command"),
  id: RequestFrameId,
  command: Command,
});

/** The page is in view (true) or hidden (false). Unanswered. */
export const ClientVisibility = z.object({
  type: z.literal("visibility"),
  visible: z.boolean(),
});

export const ClientFrame = z.discriminatedUnion("type", [ClientPing, ClientCommand, ClientVisibility]);
export type ClientFrame = z.infer<typeof ClientFrame>;
