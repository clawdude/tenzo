import type {
  AutomationProblem,
  AutomationView,
  LiveInfo,
  ProjectView,
  QueueItem,
  ServerFrame,
  ThreadView,
} from "@tenzo/contracts";

/** What the daemon has, as far as the client knows: what the Pass and the Threads list draw. */
export interface Data {
  /** Active threads, oldest first. */
  readonly threads: readonly ThreadView[];
  /** Open items, oldest first. */
  readonly items: readonly QueueItem[];
  /** Projects a thread can start in, by name. */
  readonly projects: readonly ProjectView[];
  /** Where threads' live apps are served, from the snapshot. */
  readonly live: LiveInfo | null;
  /** The projects' automations: schedule, next run, last run. */
  readonly automations: readonly AutomationView[];
  /** The automations' off switch: no schedule starts a run while it is on. */
  readonly automationsPaused: boolean;
  /** Projects whose config can't be read, so their automations don't run. */
  readonly automationProblems: readonly AutomationProblem[];
}

export const EMPTY: Data = {
  threads: [],
  items: [],
  projects: [],
  live: null,
  automations: [],
  automationsPaused: false,
  automationProblems: [],
};

/**
 * Applies one daemon frame to the data, as a pure function. A snapshot replaces everything; a
 * `thread` or `item` frame carries the record as it is now, so applying it is an upsert or, once
 * archived or resolved, a removal. That makes repeats harmless. An `automations` frame carries
 * the whole list and replaces it. A frame that changes nothing returns `data` itself.
 */
export function applyFrame(data: Data, frame: ServerFrame): Data {
  switch (frame.type) {
    case "snapshot":
      return {
        threads: frame.snapshot.threads,
        items: frame.snapshot.items,
        projects: frame.snapshot.projects,
        live: frame.snapshot.live,
        automations: frame.snapshot.automations,
        automationsPaused: frame.snapshot.automationsPaused,
        automationProblems: frame.snapshot.automationProblems,
      };
    case "automations":
      return {
        ...data,
        automations: frame.automations,
        automationsPaused: frame.paused,
        automationProblems: frame.problems,
      };
    case "thread": {
      const threads = put(data.threads, frame.thread, frame.thread.status === "active");
      return threads === data.threads ? data : { ...data, threads };
    }
    case "item": {
      const items = put(data.items, frame.item, frame.item.status === "open");
      return items === data.items ? data : { ...data, items };
    }
    default:
      return data;
  }
}

/** `list` with `record` in place of the one with its id (or at the end), or without it. */
function put<T extends { id: string }>(list: readonly T[], record: T, keep: boolean): readonly T[] {
  const index = list.findIndex((r) => r.id === record.id);
  if (!keep) return index === -1 ? list : list.filter((r) => r.id !== record.id);
  if (index === -1) return [...list, record];
  const next = [...list];
  next[index] = record;
  return next;
}
