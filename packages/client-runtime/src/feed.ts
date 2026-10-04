import type { CommandResult, StoredEvent, ThreadView } from "@tenzo/contracts";

/**
 * One watched thread's events as the client holds them (`TenzoClient.watch`): the daemon's
 * backlog, then each new event as it streams in, and older pages on request. Kept in log order,
 * each event once, and never more than `MAX_FEED_EVENTS` of them: past that the oldest go, and
 * can be paged in again.
 */
export interface Feed {
  threadId: string;
  /** The thread as of the watch's answer; the live one is in `TenzoState.threads`. */
  thread: ThreadView | null;
  /** Oldest first, by `seq`. */
  events: readonly StoredEvent[];
  /** The daemon has earlier events than `events[0]`: `loadOlder` pages them in. */
  older: boolean;
  /**
   * `loading`: waiting for the backlog. `live`: new events stream in. `offline`: the connection
   * dropped; `events` are as of then, and the feed catches up once it is back. `failed`: the
   * daemon refused the watch (`error` says why).
   */
  status: "loading" | "live" | "offline" | "failed";
  error: string | null;
  /** An older page is on its way. */
  loadingOlder: boolean;
}

/** The most events one feed keeps. */
export const MAX_FEED_EVENTS = 2000;

/** How many older events one `loadOlder` asks for. */
export const OLDER_PAGE = 200;

export function emptyFeed(threadId: string): Feed {
  return {
    threadId,
    thread: null,
    events: [],
    older: false,
    status: "loading",
    error: null,
    loadingOlder: false,
  };
}

/** The seq a re-watch continues after: the last event held, if any. */
export function lastSeqOf(feed: Feed): number | undefined {
  return feed.events.at(-1)?.seq;
}

/**
 * A watch's answer. A reset backlog replaces what the feed had; otherwise it follows on from the
 * feed's last event (a reconnect that caught up) and is appended.
 */
export function applyBacklog(feed: Feed, result: CommandResult<"thread.watch">): Feed {
  const base = { ...feed, thread: result.thread, status: "live" as const, error: null };
  if (result.reset) {
    return capped({ ...base, events: result.events, older: result.older });
  }
  return capped({ ...base, events: merge(feed.events, result.events) });
}

/** A new event from the stream: appended unless the feed has it already. */
export function appendLive(feed: Feed, event: StoredEvent): Feed {
  const last = feed.events.at(-1)?.seq ?? 0;
  if (event.seq <= last) return feed;
  return capped({ ...feed, events: [...feed.events, event] });
}

/**
 * An older page (`thread.events` with `before`): put in front, as many as there's room for. What
 * doesn't fit stays on the daemon, so `older` stays true. `before` is the seq the page was asked
 * before: if the feed no longer starts there (a reconnect replaced it meanwhile), the page would
 * leave a gap, so it is dropped.
 */
export function prependOlder(
  feed: Feed,
  page: readonly StoredEvent[],
  older: boolean,
  before: number,
): Feed {
  if (feed.events[0]?.seq !== before) return { ...feed, loadingOlder: false };
  const fresh = page.filter((e) => e.seq < before);
  const room = Math.max(0, MAX_FEED_EVENTS - feed.events.length);
  const kept = fresh.slice(Math.max(0, fresh.length - room));
  return {
    ...feed,
    events: [...kept, ...feed.events],
    older: older || kept.length < fresh.length,
    loadingOlder: false,
  };
}

/** The daemon has earlier events and the feed has room for them: "Earlier" can page them in. */
export function canLoadOlder(feed: Feed): boolean {
  return feed.older && feed.events.length > 0 && feed.events.length < MAX_FEED_EVENTS;
}

/** The feed's events in log order, each once. */
function merge(held: readonly StoredEvent[], more: readonly StoredEvent[]): StoredEvent[] {
  const last = held.at(-1)?.seq ?? 0;
  return [...held, ...more.filter((e) => e.seq > last)];
}

/** At most `MAX_FEED_EVENTS`, the newest; dropping any means there are older ones again. */
function capped(feed: Feed): Feed {
  const over = feed.events.length - MAX_FEED_EVENTS;
  if (over <= 0) return feed;
  return { ...feed, events: feed.events.slice(over), older: true };
}
