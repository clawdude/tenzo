import type {
  AgentKind,
  Attachment,
  EnvironmentId,
  Preview,
  EventId,
  ItemError,
  QueueItem,
  QueueItemId,
  QueueItemResolution,
  RequestId,
  RuntimeEvent,
  RuntimeEventOf,
  ThreadPhase,
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
  /**
   * Discussing until a proposal is approved, then building; review once the agent reports;
   * landing after Merge or Open PR, building again after Needs changes.
   */
  readonly phase: ThreadPhase;
  /** Screenshots attached since the last report: they go on the next one. */
  readonly attachments: readonly Attachment[];
  /** The dev server the agent exposed last; the daemon forwards the thread's live base to it. */
  readonly preview: Preview | null;
  /** When the agent asked to be woken next, and why (`wake_me`); null when it didn't. */
  readonly wake: Wake | null;
  /** The current (or last) turn's prompt, when Tenzo sent it: what Retry sends again. */
  readonly prompt: string | null;
  /** The agent's last `runtime.error` in the current turn: why it failed, if it does. */
  readonly error: string | null;
}

export interface Wake {
  at: string;
  why: string;
}

export interface FoldState {
  readonly runtime: ThreadRuntime;
  /** The thread's open items, oldest first. */
  readonly open: readonly QueueItem[];
  /** Every request the thread has opened an item for, open or not: a repeat opens nothing. */
  readonly known: ReadonlySet<RequestId>;
}

/** Something that happened to an item; `item` is how it is now. */
export interface ItemChange {
  type: "opened" | "updated" | "detached" | "snoozed" | "unsnoozed" | "resolved";
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
  phase: "discussing",
  attachments: [],
  preview: null,
  wake: null,
  prompt: null,
  error: null,
};
export const INITIAL_STATE: FoldState = { runtime: INITIAL_RUNTIME, open: [], known: new Set() };

/** Context kept on an item: about two lines on a phone. */
export const CONTEXT_LIMIT = 280;

/** An error's message kept on its item: the start says what, a stderr tail may follow. */
export const ERROR_LIMIT = 1_000;

/** An error's buttons: Retry is the suggestion; telling it something is the free text. */
export const ERROR_OPTIONS: readonly UserInputOption[] = [
  { label: "Retry", value: "retry", description: "", recommended: true },
  { label: "Archive", value: "archive", description: "", recommended: false },
];

const AGENT_NAMES: Record<AgentKind, string> = { claude: "Claude", codex: "Codex" };

/** A permission request's buttons: allowing is the suggestion, as in Claude Code's own prompt. */
export const PERMISSION_OPTIONS: readonly UserInputOption[] = [
  { label: "Allow", value: "allow", description: "", recommended: true },
  { label: "Deny", value: "deny", description: "", recommended: false },
];

/** A proposal's one button. Changing something is the free text under it. */
export const PROPOSAL_OPTIONS: readonly UserInputOption[] = [
  { label: "Build it", value: "build", description: "", recommended: true },
];

/**
 * Finished work's buttons (PRODUCT.md §4): Merge is the suggestion; Needs changes is the free
 * text under them. Done (nothing to land) stays for work that was never meant to merge.
 */
export const FINISHED_OPTIONS: readonly UserInputOption[] = [
  { label: "Merge", value: "merge", description: "Open the PR, see it through, merge it", recommended: true },
  { label: "Open PR", value: "pr", description: "Open the PR; ask me before merging", recommended: false },
  { label: "Done", value: "done", description: "Nothing to land", recommended: false },
];

/** A ready PR's one button. Not yet is the free text under it. */
export const READY_OPTIONS: readonly UserInputOption[] = [
  { label: "Merge", value: "merge", description: "", recommended: true },
];

/** What a finished item asks when the agent gave no headline. */
export const FINISHED_ASK = "Ready for review";

/** What a ready item asks when the agent gave no headline. */
export const READY_ASK = "Ready to merge";

/**
 * The kinds of item an agent asks and then waits on, in its turn. Finished work, ready PRs and
 * errors wait on you, not on the agent.
 */
const ASKS: ReadonlySet<QueueItem["kind"]> = new Set(["question", "permission", "proposal"]);

/**
 * The agent's turn is waiting on you: an open ask from its live session. A detached ask (from
 * a session that has ended), finished work, a ready PR or an error card doesn't count.
 */
export function waitsOnYou(open: readonly QueueItem[]): boolean {
  return open.some((item) => ASKS.has(item.kind) && !item.detached);
}

type Asking =
  | RuntimeEventOf<"user-input.requested">
  | RuntimeEventOf<"request.opened">
  | RuntimeEventOf<"proposal.requested">;

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
      // Finished work and ready PRs wait on you, not on the agent: they never detach.
      const changes: ItemChange[] = [];
      const open = state.open.map((item) => {
        if (item.detached || !ASKS.has(item.kind)) return item;
        const detached = { ...item, detached: true };
        changes.push({ type: "detached", item: detached });
        return detached;
      });
      const ended: FoldState = {
        ...state,
        runtime: { ...runtime, live: false, turnId: null },
        open,
      };
      // The agent crashed mid-turn with nothing to ask you: without a card the thread would just
      // look done, its work half finished. A graceful exit is one Tenzo asked for (an archive, the
      // daemon stopping, which resumes the turn when it starts again: engine.ts), so no card.
      if (
        event.payload.exitKind !== "error" ||
        runtime.turnId === null ||
        waitsOnYou(state.open)
      ) {
        return { state: ended, changes };
      }
      const name = AGENT_NAMES[event.agent];
      return withError(ended, changes, event, runtime, environmentId, {
        cause: "crash",
        message:
          event.payload.reason ?? runtime.error ?? `${name} exited before its turn finished.`,
        prompts: runtime.prompt === null ? [] : [runtime.prompt],
      });
    }
    case "turn.started": {
      // A prompt of ours went: whatever failed before is behind it, so its error card goes. A
      // turn the agent starts by itself (a background task reporting) changes nothing about it.
      const ours = event.payload.prompt !== undefined;
      const changes: ItemChange[] = [];
      const open = state.open.filter((item) => {
        if (item.kind !== "error" || !ours) return true;
        changes.push({
          type: "resolved",
          item: {
            ...item,
            status: "resolved",
            resolvedAt: event.createdAt,
            resolution: { kind: "recovered" },
          },
        });
        return false;
      });
      return {
        state: {
          ...state,
          runtime: {
            ...runtime,
            turnId: event.turnId,
            context: "",
            prompt: event.payload.prompt ?? null,
            error: null,
          },
          open,
        },
        changes,
      };
    }
    case "turn.completed": {
      const next: FoldState = {
        ...state,
        runtime: { ...runtime, turnId: runtime.turnId === event.turnId ? null : runtime.turnId },
      };
      if (event.payload.state !== "failed") return same(next);
      return withError(next, [], event, runtime, environmentId, {
        cause: "turn",
        message: event.payload.errorMessage ?? runtime.error ?? "The turn failed.",
        prompts: runtime.prompt === null ? [] : [runtime.prompt],
      });
    }
    case "runtime.error": {
      // No session and no turn: the agent couldn't even start (engine.ts drops the prompts that
      // were waiting, and says which). Otherwise it is why the turn or the session will end.
      if (runtime.live || runtime.turnId !== null) {
        return same({ ...state, runtime: { ...runtime, error: event.payload.message } });
      }
      // Still can't start: the card it already has says so, now with these prompts too.
      const unsent = event.payload.unsent ?? [];
      const card = state.open.find((i) => i.kind === "error" && i.error?.cause === "start");
      if (card?.error) {
        const item: QueueItem = {
          ...card,
          error: {
            ...card.error,
            message: cutMessage(event.payload.message.trim()),
            prompts: [...card.error.prompts, ...unsent],
          },
        };
        return {
          state: { ...state, open: state.open.map((i) => (i === card ? item : i)) },
          changes: [{ type: "updated", item }],
        };
      }
      return withError(state, [], event, runtime, environmentId, {
        cause: "start",
        message: event.payload.message,
        prompts: unsent,
      });
    }
    case "error.resolved": {
      const { action, text } = event.payload;
      return resolve(
        state,
        event,
        action === "retry" ? { kind: "retried" } : { kind: "told", text: text ?? "" },
      );
    }
    case "item.snoozed":
    case "item.unsnoozed": {
      const found = state.open.find((item) => item.requestId === event.requestId);
      const until = event.type === "item.snoozed" ? event.payload.until : null;
      if (!found || found.snoozedUntil === until) return same(state);
      const item: QueueItem = { ...found, snoozedUntil: until };
      return {
        state: { ...state, open: state.open.map((i) => (i === found ? item : i)) },
        changes: [{ type: event.type === "item.snoozed" ? "snoozed" : "unsnoozed", item }],
      };
    }
    case "item.completed": {
      const p = event.payload;
      if (p.itemType !== "assistant_message" || p.parentItemId || !p.text?.trim()) {
        return same(state);
      }
      return same({ ...state, runtime: { ...runtime, context: trimContext(p.text) } });
    }
    case "user-input.requested":
    case "request.opened":
    case "proposal.requested": {
      // Seen before, even if long resolved: never a second item for it.
      if (state.known.has(event.requestId)) return same(state);
      const item = openItem(event, runtime.context, environmentId);
      return {
        state: {
          ...state,
          open: [...state.open, item],
          known: new Set([...state.known, event.requestId]),
        },
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
    case "proposal.resolved": {
      const { decision, note } = event.payload;
      // Approved is approved, whether or not its item is still open here: the thread builds.
      const next =
        decision === "build" ? { ...state, runtime: { ...runtime, phase: "building" as const } } : state;
      return resolve(
        next,
        event,
        decision === "build"
          ? { kind: "approved" }
          : decision === "change"
            ? { kind: "revise", note: note ?? "" }
            : { kind: "cancelled" },
      );
    }
    case "attachment.added":
      return same({
        ...state,
        runtime: { ...runtime, attachments: [...runtime.attachments, event.payload.attachment] },
      });
    case "preview.exposed":
      return same({
        ...state,
        runtime: { ...runtime, preview: { port: event.payload.port, path: event.payload.path } },
      });
    case "report.submitted": {
      if (state.known.has(event.requestId)) return same(state);
      // A newer report replaces the one still waiting: one finished card per thread.
      const superseded = supersede(state, "finished", event.createdAt);
      const item = finishedItem(event, runtime, environmentId);
      return {
        state: {
          // Only built work goes to review: a report before Build it (the adapter refuses one)
          // must not skip the proposal, so the thread keeps discussing; nor does a report while
          // landing (refused too) undo Merge or Open PR.
          runtime: {
            ...runtime,
            phase: runtime.phase === "building" || runtime.phase === "review" ? "review" : runtime.phase,
            attachments: [],
          },
          open: [...state.open.filter((open) => open.kind !== "finished"), item],
          known: new Set([...state.known, event.requestId]),
        },
        changes: [...superseded, { type: "opened", item }],
      };
    }
    case "report.resolved": {
      const { decision, note } = event.payload;
      // Like an approval, the answer moves the thread whether or not its card is still open.
      const phase =
        decision === "merge" || decision === "pr"
          ? ("landing" as const)
          : decision === "changes"
            ? ("building" as const)
            : runtime.phase;
      return resolve(
        { ...state, runtime: { ...runtime, phase } },
        event,
        decision === "changes" ? { kind: "changes", note: note ?? "" } : { kind: decision },
      );
    }
    case "merge.ready": {
      if (state.known.has(event.requestId)) return same(state);
      // One ready card per thread: a newer one replaces it.
      const superseded = supersede(state, "ready", event.createdAt);
      const item = readyItem(event, runtime.context, environmentId);
      return {
        state: {
          ...state,
          open: [...state.open.filter((open) => open.kind !== "ready"), item],
          known: new Set([...state.known, event.requestId]),
        },
        changes: [...superseded, { type: "opened", item }],
      };
    }
    case "merge.resolved": {
      const { decision, note } = event.payload;
      return resolve(
        state,
        event,
        decision === "merge" ? { kind: "merge" } : { kind: "changes", note: note ?? "" },
      );
    }
    case "wake.scheduled":
      return same({
        ...state,
        runtime: { ...runtime, wake: { at: event.payload.at, why: event.payload.why } },
      });
    case "wake.fired":
      return same({ ...state, runtime: { ...runtime, wake: null } });
    case "landing.stuck": {
      // One landing card at a time: a newer one says what is wrong now.
      const superseded = state.open
        .filter((open) => open.kind === "error" && isLandingCause(open.error?.cause))
        .map(
          (open): ItemChange => ({
            type: "resolved",
            item: {
              ...open,
              status: "resolved",
              resolvedAt: event.createdAt,
              resolution: { kind: "superseded" },
            },
          }),
        );
      const rest: FoldState = {
        ...state,
        open: state.open.filter((open) => !superseded.some((s) => s.item.id === open.id)),
      };
      const { cause, message, prompts } = event.payload;
      return withError(rest, superseded, event, runtime, environmentId, { cause, message, prompts });
    }
    case "thread.archived": {
      const changes = state.open.map(
        (open): ItemChange => ({
          type: "resolved",
          item: {
            ...open,
            status: "resolved",
            resolvedAt: event.createdAt,
            resolution: { kind: "dismissed" },
          },
        }),
      );
      return {
        state: {
          ...state,
          runtime: { ...runtime, live: false, turnId: null, preview: null, wake: null },
          open: [],
        },
        changes,
      };
    }
    case "session.configured":
    case "item.started":
    // The engine archives the thread once the turn that landed it ends; the log says so then.
    case "thread.landed":
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

/**
 * An error item answers no agent request: its request id is made from the event that opened it,
 * so replaying the log gives the same item again.
 */
export function errorRequestId(eventId: EventId): RequestId {
  return `req_${eventId.slice("evt_".length)}`;
}

/** What an error item's card says in a few words. */
export function errorHeadline(cause: ItemError["cause"], agent: AgentKind): string {
  const name = AGENT_NAMES[agent];
  switch (cause) {
    case "turn":
      return `${name}'s turn failed`;
    case "crash":
      return `${name} stopped mid-turn`;
    case "start":
      return `${name} couldn't start`;
    case "stalled":
      return "Landing stalled";
    case "unarchived":
      return "Landed, but not archived";
  }
}

/** The error causes of landing cards (`landing.stuck`): Retry sends what they say. */
export function isLandingCause(cause: ItemError["cause"] | undefined): boolean {
  return cause === "stalled" || cause === "unarchived";
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
  event: Asking,
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
    ...(event.payload.fingerprint ? { fingerprint: event.payload.fingerprint } : {}),
    createdAt: event.createdAt,
    status: "open" as const,
    detached: false,
    resolvedAt: null,
    resolution: null,
    snoozedUntil: null,
  };
  if (event.type === "proposal.requested") {
    const { headline, summary } = event.payload;
    return {
      ...common,
      kind: "proposal",
      ask: headline,
      options: [...PROPOSAL_OPTIONS],
      suggested: "build",
      questions: [],
      proposal: { headline, summary },
    };
  }
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

/** Finished work, from a report and what the agent attached and exposed before it. */
function finishedItem(
  event: RuntimeEventOf<"report.submitted">,
  runtime: ThreadRuntime,
  environmentId: EnvironmentId,
): QueueItem {
  const { headline, summary, howToTest, checks } = event.payload;
  return {
    id: itemIdFor(event.requestId),
    environmentId,
    threadId: event.threadId,
    lane: "review",
    kind: "finished",
    requestId: event.requestId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    context: runtime.context,
    ask: headline || FINISHED_ASK,
    options: [...FINISHED_OPTIONS],
    suggested: "merge",
    questions: [],
    finished: {
      ...(headline ? { headline } : {}),
      summary,
      howToTest,
      checks,
      attachments: [...runtime.attachments],
      live: runtime.preview,
    },
    createdAt: event.createdAt,
    status: "open",
    detached: false,
    resolvedAt: null,
    resolution: null,
    snoozedUntil: null,
  };
}

/** A ready PR, from `ready_to_merge`: quick lane, since the agent is waiting on your Merge. */
function readyItem(
  event: RuntimeEventOf<"merge.ready">,
  context: string,
  environmentId: EnvironmentId,
): QueueItem {
  const { url, summary, headline } = event.payload;
  return {
    id: itemIdFor(event.requestId),
    environmentId,
    threadId: event.threadId,
    lane: "quick",
    kind: "ready",
    requestId: event.requestId,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    context,
    ask: headline || READY_ASK,
    options: [...READY_OPTIONS],
    suggested: "merge",
    questions: [],
    ready: { url, summary },
    createdAt: event.createdAt,
    status: "open",
    detached: false,
    resolvedAt: null,
    resolution: null,
    snoozedUntil: null,
  };
}

/** The thread's open items of `kind`, resolved as replaced by a newer one. */
function supersede(state: FoldState, kind: QueueItem["kind"], at: string): ItemChange[] {
  return state.open
    .filter((open) => open.kind === kind)
    .map(
      (open): ItemChange => ({
        type: "resolved",
        item: { ...open, status: "resolved", resolvedAt: at, resolution: { kind: "superseded" } },
      }),
    );
}

/** `state` with an error item opened by `event`, added to `changes`. */
function withError(
  state: FoldState,
  changes: ItemChange[],
  event: RuntimeEvent,
  runtime: ThreadRuntime,
  environmentId: EnvironmentId,
  error: ItemError,
): Folded {
  const requestId = errorRequestId(event.eventId);
  if (state.known.has(requestId)) return { state, changes };
  const turnId = event.turnId ?? runtime.turnId;
  const item: QueueItem = {
    id: itemIdFor(requestId),
    environmentId,
    threadId: event.threadId,
    lane: "quick",
    kind: "error",
    requestId,
    ...(turnId ? { turnId } : {}),
    context: runtime.context,
    ask: errorHeadline(error.cause, event.agent),
    options: [...ERROR_OPTIONS],
    suggested: "retry",
    questions: [],
    error: { ...error, message: cutMessage(error.message.trim()) },
    createdAt: event.createdAt,
    status: "open",
    detached: false,
    resolvedAt: null,
    resolution: null,
    snoozedUntil: null,
  };
  return {
    state: { ...state, open: [...state.open, item], known: new Set([...state.known, requestId]) },
    changes: [...changes, { type: "opened", item }],
  };
}

function cutMessage(text: string, limit = ERROR_LIMIT): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function resolve(
  state: FoldState,
  event:
    | RuntimeEventOf<"user-input.resolved">
    | RuntimeEventOf<"request.resolved">
    | RuntimeEventOf<"proposal.resolved">
    | RuntimeEventOf<"report.resolved">
    | RuntimeEventOf<"merge.resolved">
    | RuntimeEventOf<"error.resolved">,
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
