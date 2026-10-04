import { describe, expect, it } from "vitest";
import {
  appendLive,
  applyBacklog,
  canLoadOlder,
  emptyFeed,
  type Feed,
  lastSeqOf,
  MAX_FEED_EVENTS,
  prependOlder,
} from "./feed.ts";
import { stored, thread } from "./testing.ts";

const seqs = (feed: Feed) => feed.events.map((e) => e.seq);
const backlog = (events: number[], extra: { older?: boolean; reset?: boolean } = {}) => ({
  thread: thread("a"),
  events: events.map((s) => stored(s, "a")),
  older: extra.older ?? false,
  reset: extra.reset ?? true,
});

describe("feed", () => {
  it("starts loading, and goes live with the backlog", () => {
    const feed = applyBacklog(emptyFeed("t"), backlog([3, 5, 9], { older: true }));
    expect(feed).toMatchObject({ status: "live", older: true, thread: thread("a"), error: null });
    expect(seqs(feed)).toEqual([3, 5, 9]);
    expect(lastSeqOf(feed)).toBe(9);
    expect(lastSeqOf(emptyFeed("t"))).toBeUndefined();
  });

  it("appends live events once, in order", () => {
    let feed = applyBacklog(emptyFeed("t"), backlog([3, 5]));
    feed = appendLive(feed, stored(7, "a"));
    expect(appendLive(feed, stored(7, "a"))).toBe(feed); // a repeat
    expect(appendLive(feed, stored(5, "a"))).toBe(feed); // already in the backlog
    expect(seqs(appendLive(feed, stored(8, "a")))).toEqual([3, 5, 7, 8]);
  });

  it("on a re-watch, appends what follows on, or replaces everything after a reset", () => {
    const had = { ...applyBacklog(emptyFeed("t"), backlog([3, 5], { older: true })), status: "offline" as const };
    const caught = applyBacklog(had, backlog([5, 8, 9], { reset: false }));
    expect(seqs(caught)).toEqual([3, 5, 8, 9]);
    expect(caught).toMatchObject({ status: "live", older: true });
    const fresh = applyBacklog(had, backlog([40, 41], { reset: true, older: true }));
    expect(seqs(fresh)).toEqual([40, 41]);
  });

  it("keeps at most MAX_FEED_EVENTS, dropping the oldest, which can be paged in again", () => {
    const many = Array.from({ length: MAX_FEED_EVENTS }, (_, i) => i + 1);
    let feed = applyBacklog(emptyFeed("t"), backlog(many));
    expect(feed.older).toBe(false);
    feed = appendLive(feed, stored(MAX_FEED_EVENTS + 1, "a"));
    expect(feed.events).toHaveLength(MAX_FEED_EVENTS);
    expect(feed.events[0]?.seq).toBe(2);
    expect(feed.older).toBe(true);
  });

  it("puts older pages in front, as many as fit, skipping what it has", () => {
    const feed = { ...applyBacklog(emptyFeed("t"), backlog([10, 11], { older: true })), loadingOlder: true };
    const paged = prependOlder(feed, [7, 8, 10].map((s) => stored(s, "a")), false, 10);
    expect(seqs(paged)).toEqual([7, 8, 10, 11]);
    expect(paged).toMatchObject({ older: false, loadingOlder: false });

    const full = applyBacklog(
      emptyFeed("t"),
      backlog(Array.from({ length: MAX_FEED_EVENTS - 1 }, (_, i) => 100 + i), { older: true }),
    );
    const topped = prependOlder(full, [97, 98, 99].map((s) => stored(s, "a")), false, 100);
    expect(topped.events).toHaveLength(MAX_FEED_EVENTS);
    expect(topped.events[0]?.seq).toBe(99);
    expect(topped.older).toBe(true); // 97 and 98 stay on the daemon
    expect(canLoadOlder(topped)).toBe(false); // full: Earlier has nothing to fetch into
    expect(canLoadOlder(full)).toBe(true);
    expect(canLoadOlder(paged)).toBe(false); // nothing older
  });

  it("drops an older page when a reset replaced the feed while it was on its way", () => {
    const asked = { ...applyBacklog(emptyFeed("t"), backlog([10, 11], { older: true })), loadingOlder: true };
    const replaced = { ...applyBacklog(asked, backlog([40, 41], { older: true })), loadingOlder: true };
    const after = prependOlder(replaced, [7, 8].map((s) => stored(s, "a")), true, 10);
    expect(seqs(after)).toEqual([40, 41]);
    expect(after).toMatchObject({ older: true, loadingOlder: false });
  });
});
