import type {
  AgentKind,
  EnvironmentId,
  QueueItem,
  QueueItemId,
  QueueItemResolution,
  RequestId,
  RuntimeEvent,
  RuntimeEventOf,
  TurnId,
  UserInputOption,
} from "@tenzo/contracts";

/**
 * Runtime events → what a thread is doing and what it needs from you, as a pure function: same
 * state and event in, same state and item changes out. The daemon applies it to each event as it
 * is appended and stores the result (event-store.ts); folding a thread's whole log from the start
 * gives the same answer, which is what makes the log the source of truth.
 * After T3 Code's ProviderRuntimeIngestion + projector, much smaller.
 */
export interface ThreadRuntime {
  /** An agent process is running for the thread: between `session.started` and `session.exited`. */
  readonly live: boolean;
  readonly agent: AgentKind | null;
  /** The agent's own session id, to resume. Outlives the process. */
  readonly sessionId: string | null;
  /** The turn in progress, if any. */
  readonly turnId: TurnId | null;
  /** What the agent said last in the current turn, trimmed: the context of its next item. */
  readonly context: string;
}

export interface FoldState {
  readonly runtime: ThreadRuntime;
  /** The thread's open items, oldest first. */
  readonly open: readonly QueueItem[];
}

/** Something that happened to an item; `item` is how it is now. */
export interface ItemChange {
  type: "opened" | "detached" | "resolved";
  item: QueueItem;
}

export interface Folded {
  state: FoldState;
  changes: ItemChange[];
}

export const INITIAL_RUNTIME: ThreadRuntime = {
  live: false,
  agent: null,
  sessionId: null,
  turnId: null,
  context: "",
};
export const INITIAL_STATE: FoldState = { runtime: INITIAL_RUNTIME, open: [] };

/** Context kept on an item: about two lines on a phone. */
export const CONTEXT_LIMIT = 280;

/** A permission request's buttons: allowing is the suggestion, as in Claude Code's own prompt. */
export const PERMISSION_OPTIONS: readonly UserInputOption[] = [
  { label: "Allow", value: "allow", description: "", recommended: true },
  { label: "Deny", value: "deny", description: "", recommended: false },
];

export function foldEvent(
  state: FoldState,
  event: RuntimeEvent,
  environmentId: EnvironmentId,
): Folded {
  const runtime = state.runtime;
  switch (event.type) {
    case "session.started":
      return same({
        ...state,
        runtime: { ...runtime, live: true, agent: event.agent, sessionId: event.payload.sessionId },
      });
    case "session.exited": {
      // Nothing is waiting on the open requests any more, and the turn is over. The items stay:
      // what was asked still needs an answer, and answering resumes the session (engine.ts).
      const changes: ItemChange[] = [];
      const open = state.open.map((item) => {
        if (item.detached) return item;
        const detached = { ...item, detached: true };
        changes.push({ type: "detached", item: detached });
        return detached;
      });
      return { state: { runtime: { ...runtime, live: false, turnId: null }, open }, changes };
    }
    case "turn.started":
      return same({ ...state, runtime: { ...runtime, turnId: event.turnId, context: "" } });
    case "turn.completed":
      return same({
        ...state,
        runtime: { ...runtime, turnId: runtime.turnId === event.turnId ? null : runtime.turnId },
      });
    case "item.completed": {
      const p = event.payload;
      if (p.itemType !== "assistant_message" || p.parentItemId || !p.text?.trim()) {
        return same(state);
      }
      return same({ ...state, runtime: { ...runtime, context: trimContext(p.text) } });
    }
    case "user-input.requested":
    case "request.opened": {
      if (state.open.some((item) => item.requestId === event.requestId)) return same(state);
      const item = openItem(event, runtime.context, environmentId);
      return {
        state: { ...state, open: [...state.open, item] },
        changes: [{ type: "opened", item }],
      };
    }
    case "user-input.resolved":
      return resolve(
        state,
        event,
        event.payload.cancelled
          ? { kind: "cancelled" }
          : { kind: "answered", answers: event.payload.answers },
      );
    case "request.resolved": {
      const { decision, message } = event.payload;
      return resolve(
        state,
        event,
        decision === "allow"
          ? { kind: "allowed" }
          : decision === "deny"
            ? { kind: "denied", ...(message ? { message } : {}) }
            : { kind: "cancelled" },
      );
    }
    case "session.configured":
    case "item.started":
    case "runtime.error":
      return same(state);
  }
}

/** Folds a log from the start (or from `state`): the state, and every item it ever opened. */
export function foldEvents(
  events: Iterable<RuntimeEvent>,
  environmentId: EnvironmentId,
  state: FoldState = INITIAL_STATE,
): { state: FoldState; items: QueueItem[] } {
  const items = new Map<QueueItemId, QueueItem>();
  let current = state;
  for (const event of events) {
    const folded = foldEvent(current, event, environmentId);
    current = folded.state;
    for (const change of folded.changes) items.set(change.item.id, change.item);
  }
  return { state: current, items: [...items.values()] };
}

/** An item's id follows from its request's: replaying the log gives the same ids. */
export function itemIdFor(requestId: RequestId): QueueItemId {
  return `itm_${requestId.slice("req_".length)}`;
}

/** The last paragraphs of an assistant message that fit in `CONTEXT_LIMIT`, whitespace folded. */
export function trimContext(text: string, limit = CONTEXT_LIMIT): string {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replaceAll(/\s+/g, " ").trim())
    .filter((p) => p !== "");
  const kept: string[] = [];
  let length = 0;
  for (const paragraph of paragraphs.reverse()) {
    const added = length === 0 ? paragraph.length : length + 1 + paragraph.length;
    if (added > limit) {
      if (kept.length === 0) return cutFromStart(paragraph, limit);
      break;
    }
    kept.unshift(paragraph);
    length = added;
  }
  return kept.join("\n");
}

/** The end of a long paragraph, cut at a word: what leads into the question is at the end. */
function cutFromStart(text: string, limit: number): string {
  const tail = text.slice(text.length - (limit - 1));
  const space = tail.indexOf(" ");
  return `…${space > 0 && space < 40 ? tail.slice(space + 1) : tail}`;
}

function openItem(
  event: RuntimeEventOf<"user-input.requested"> | RuntimeEventOf<"request.opened">,
  context: string,
  environmentId: EnvironmentId,
): QueueItem {
  const common = {
    id: itemIdFor(event.requestId),
    environmentId,
    threadId: event.threadId,
    lane: "quick" as const,
    requestId: event.requestId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    context,
    createdAt: event.createdAt,
    status: "open" as const,
    detached: false,
    resolvedAt: null,
    resolution: null,
  };
  if (event.type === "user-input.requested") {
    const questions = event.payload.questions;
    const first = questions[0];
    const options = first?.options ?? [];
    return {
      ...common,
      kind: "question",
      ask: first ? first.question || first.header : "",
      options,
      suggested: options.find((o) => o.recommended)?.value ?? null,
      questions,
    };
  }
  const p = event.payload;
  return {
    ...common,
    kind: "permission",
    ask: p.title ?? `Allow ${p.detail}?`,
    options: [...PERMISSION_OPTIONS],
    suggested: "allow",
    questions: [],
    permission: {
      toolKind: p.toolKind,
      toolName: p.toolName,
      detail: p.detail,
      ...(p.reason ? { reason: p.reason } : {}),
      input: p.input,
    },
  };
}

function resolve(
  state: FoldState,
  event: RuntimeEventOf<"user-input.resolved"> | RuntimeEventOf<"request.resolved">,
  resolution: QueueItemResolution,
): Folded {
  const found = state.open.find((item) => item.requestId === event.requestId);
  if (!found) return same(state);
  const item: QueueItem = {
    ...found,
    status: "resolved",
    resolvedAt: event.createdAt,
    resolution,
  };
  return {
    state: { ...state, open: state.open.filter((i) => i !== found) },
    changes: [{ type: "resolved", item }],
  };
}

function same(state: FoldState): Folded {
  return { state, changes: [] };
}
