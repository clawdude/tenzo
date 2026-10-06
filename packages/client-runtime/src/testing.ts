import type { AutomationProblem, AutomationView, ProjectView, QueueItem, StoredEvent, ThreadView } from "@tenzo/contracts";

/**
 * Test-only doubles: a WebSocket the test drives by hand, a clock the test advances, and
 * records that pass the contracts.
 */

export class FakeSocket {
  static OPEN = 1;
  static instances: FakeSocket[] = [];
  /** When set, the next constructions throw this (and consume one entry each). */
  static throwNext: unknown[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  closed = false;
  constructor(public url: string) {
    if (FakeSocket.throwNext.length > 0) throw FakeSocket.throwNext.shift();
    FakeSocket.instances.push(this);
  }
  static reset() {
    FakeSocket.instances = [];
    FakeSocket.throwNext = [];
  }
  send(data: string) {
    this.sent.push(data);
  }
  /** What the client sent, parsed. */
  get frames(): { type: string; [key: string]: unknown }[] {
    return this.sent.map((s) => JSON.parse(s));
  }
  close() {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }
  serverOpens() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  serverSends(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  serverDrops() {
    this.readyState = 3;
    this.onclose?.();
  }
}

/** Timers that run when the test advances time. */
export class FakeClock {
  now = 0;
  #next = 1;
  readonly pending = new Map<number, { fn: () => void; at: number; ms: number }>();
  /** Every delay ever scheduled, in order. */
  readonly delays: number[] = [];
  setTimeout = ((fn: () => void, ms: number) => {
    const id = this.#next++;
    this.pending.set(id, { fn, at: this.now + ms, ms });
    this.delays.push(ms);
    return id;
  }) as unknown as typeof setTimeout;
  clearTimeout = ((id: number) => {
    this.pending.delete(id);
  }) as unknown as typeof clearTimeout;

  /** Moves time forward by `ms`, running every timer that comes due, in order. */
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = [...this.pending]
        .filter(([, t]) => t.at <= until)
        .sort(([a, x], [b, y]) => x.at - y.at || a - b)[0];
      if (!due) break;
      const [id, timer] = due;
      this.pending.delete(id);
      this.now = timer.at;
      timer.fn();
    }
    this.now = until;
  }

  /** Delays of the timers now pending. */
  get waiting(): number[] {
    return [...this.pending.values()].map((t) => t.ms);
  }
}

const environmentId = "env_abcdefghij0123456789";
const at = "2026-10-02T00:00:00.000Z";

export const hello = {
  type: "hello",
  environmentId,
  version: "0.0.1",
  serverTime: at,
} as const;

/** A thread id or item id from a short tag: `id("thr", "a")` → `thr_aaaaaaaaaaaaaaaaaaaa`. */
export function id<P extends string>(prefix: P, tag: string): `${P}_${string}` {
  return `${prefix}_${tag.repeat(20).slice(0, 20)}`;
}

export function thread(tag: string, overrides: Partial<ThreadView> = {}): ThreadView {
  return {
    id: id("thr", tag) as ThreadView["id"],
    environmentId,
    projectId: id("prj", "p") as ThreadView["projectId"],
    projectName: "app",
    title: `Thread ${tag}`,
    branch: `tenzo/${tag}`,
    worktreePath: `/tmp/${tag}`,
    status: "active",
    agent: "claude",
    model: null,
    thinking: null,
    landing: "merge",
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    phase: "discussing",
    landed: false,
    origin: "user",
    parentId: null,
    automation: null,
    wakeAt: null,
    activity: "working",
    working: true,
    queued: 0,
    openItems: 0,
    lastSeq: 1,
    activeAt: at,
    ...overrides,
  };
}

export function project(name: string): ProjectView {
  return {
    id: id("prj", name.charAt(0)) as ProjectView["id"],
    environmentId,
    name,
    defaultBranch: "main",
  };
}

export function automation(name: string, overrides: Partial<AutomationView> = {}): AutomationView {
  return {
    projectId: id("prj", "p") as AutomationView["projectId"],
    projectName: "app",
    name,
    summary: "Check the dependencies.",
    schedule: "every 1h",
    timeZone: "UTC",
    enabled: true,
    budget: { wallClockMs: 3_600_000, costUsd: 2 },
    model: null,
    nextRunAt: at,
    lastRun: null,
    finishedRuns: 0,
    ...overrides,
  };
}

export function item(tag: string, threadTag: string, overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: id("itm", tag) as QueueItem["id"],
    environmentId,
    threadId: id("thr", threadTag) as QueueItem["threadId"],
    lane: "quick",
    kind: "question",
    requestId: id("req", tag) as QueueItem["requestId"],
    context: "",
    ask: "Which color?",
    options: [
      { label: "Red", value: "Red", description: "", recommended: true },
      { label: "Blue", value: "Blue", description: "", recommended: false },
    ],
    suggested: "Red",
    questions: [],
    createdAt: at,
    status: "open",
    detached: false,
    resolvedAt: null,
    resolution: null,
    snoozedUntil: null,
    ...overrides,
  };
}

/** A stored event of the thread tagged `threadTag`: an assistant line saying `text`. */
export function stored(seq: number, threadTag: string, text = `line ${seq}`): StoredEvent {
  return {
    seq,
    environmentId,
    event: {
      type: "item.completed",
      eventId: `evt_${String(seq).padStart(20, "0")}`,
      threadId: id("thr", threadTag) as StoredEvent["event"]["threadId"],
      agent: "claude",
      createdAt: at,
      itemId: `m${seq}`,
      payload: { itemType: "assistant_message", status: "completed", text },
    },
  };
}

export function snapshotFrame(
  threads: ThreadView[],
  items: QueueItem[],
  projects: ProjectView[] = [],
  live: { port: number; origins: string[]; grant: string | null } | null = null,
) {
  return {
    type: "snapshot",
    snapshot: {
      environmentId,
      threads,
      items,
      projects,
      live,
      automations: [] as AutomationView[],
      automationsPaused: false,
      automationProblems: [] as AutomationProblem[],
    },
  } as const;
}
