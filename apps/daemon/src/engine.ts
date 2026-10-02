import type {
  AgentKind,
  ItemAnswer,
  QueueItem,
  QueueItemId,
  RuntimeEvent,
  Snapshot,
  StoredEvent,
  ThreadId,
  ThreadView,
  TurnId,
} from "@tenzo/contracts";
import type { AgentAdapter, AgentSession } from "./agent/agent.ts";
import {
  checkAnswer,
  deliveryPrompt,
  requestFingerprint,
  type StandingReply,
  standingReply,
} from "./answers.ts";
import { TenzoError } from "./errors.ts";
import {
  appendEvent,
  clearPrompts,
  dismissItems,
  enqueuePrompt,
  getItem,
  lastSeq,
  liveThreads,
  loadFoldState,
  nextPrompt,
  openItems,
  queuedCount,
  removePrompt,
  threadEvents,
  threadsWithPrompts,
} from "./event-store.ts";
import type { ItemChange } from "./fold.ts";
import { titleFrom } from "./format.ts";
import { randomId } from "./ids.ts";
import { findProject } from "./projects.ts";
import type { Store } from "./store.ts";
import { archiveThread, createThread, getThread, listThreads, projectOf, type Thread } from "./threads.ts";

/**
 * The daemon's thread runner: it owns every running agent session. It starts and resumes them,
 * sends each thread's prompts one turn at a time from a queue, appends every event the agents
 * report to the log (folding it into items as it goes), and routes answers back to the agent.
 *
 * The methods are the daemon's commands (commands.ts maps the wire vocabulary onto them), so the
 * CLI's HTTP route today and the WebSocket (#7) share one implementation.
 */
export interface EngineOptions {
  store: Store;
  /** The adapter for each agent a thread can run. Tests pass fakes. */
  adapters: Partial<Record<AgentKind, AgentAdapter>>;
  /** How long an answer waits for the agent to confirm it took it. */
  answerTimeoutMs?: number;
  log?: (message: string) => void;
}

/** What subscribers hear: each event as stored, each item change, each thread change. */
export type EngineChange =
  | ({ type: "event" } & StoredEvent)
  | { type: "item"; change: ItemChange }
  | { type: "thread"; thread: ThreadView };

interface Live {
  threadId: ThreadId;
  session: AgentSession;
  /** The turn of the prompt we sent last, until it completes. One at a time. */
  turnId: TurnId | null;
  /** Answers to give, instead of asking again, if the agent repeats an ask in this turn. */
  standing: StandingReply[];
  /** Ends when the session's events do. */
  reading: Promise<void>;
}

export class Engine {
  readonly store: Store;
  readonly #adapters: EngineOptions["adapters"];
  readonly #answerTimeoutMs: number;
  readonly #log: (message: string) => void;
  readonly #live = new Map<ThreadId, Live>();
  readonly #listeners = new Set<(change: EngineChange) => void>();
  /** Live answers waiting for the agent's `*.resolved` event. */
  readonly #answering = new Map<QueueItemId, (item: QueueItem) => void>();
  readonly #archiving = new Set<ThreadId>();
  #closing = false;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.#adapters = options.adapters;
    this.#answerTimeoutMs = options.answerTimeoutMs ?? 10_000;
    this.#log = options.log ?? ((message) => console.error(`tenzo: ${message}`));
  }

  /**
   * Picks up where the last daemon left off. Sessions it was running are gone with it: their
   * open items become detached (answering them resumes the session), and prompts still queued
   * are sent, resuming their threads.
   */
  start(): void {
    for (const threadId of liveThreads(this.store)) {
      const thread = getThread(this.store, threadId);
      this.#append(
        draft(thread, {
          type: "session.exited",
          payload: { exitKind: "error", reason: "Tenzo stopped while this session was running." },
        }),
      );
    }
    for (const threadId of threadsWithPrompts(this.store)) this.#pump(threadId);
  }

  subscribe(listener: (change: EngineChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async createThread(input: {
    project: string;
    title?: string;
    prompt?: string;
    model?: string;
  }): Promise<ThreadView> {
    const prompt = input.prompt?.trim();
    const title = input.title?.trim() || (prompt ? titleFrom(prompt) : "");
    if (title === "") throw new TenzoError("A new thread needs a title or a prompt.");
    const thread = await createThread(this.store, input.project, title, {
      ...(input.model ? { model: input.model } : {}),
    });
    if (prompt) enqueuePrompt(this.store, thread.id, prompt);
    this.#pump(thread.id);
    return this.#changed(thread.id);
  }

  /** Queues a prompt; it is sent as soon as the thread's running turn (if any) ends. */
  send(threadId: string, prompt: string): ThreadView {
    const thread = this.#active(threadId);
    const text = prompt.trim();
    if (text === "") throw new TenzoError("The prompt is empty.");
    enqueuePrompt(this.store, thread.id, text);
    this.#pump(thread.id);
    return this.#changed(thread.id);
  }

  /** Stops the thread's agent, removes its worktree, and takes its items off the queue. */
  async archive(threadId: string, options: { force?: boolean } = {}): Promise<ThreadView> {
    const thread = getThread(this.store, threadId);
    if (thread.status === "archived") return this.view(thread.id);
    this.#archiving.add(thread.id); // no new session while its worktree goes away
    try {
      const live = this.#live.get(thread.id);
      if (live) {
        await live.session.stop();
        await live.reading;
      }
      await archiveThread(this.store, thread.id, options);
      this.#archiving.delete(thread.id);
    } catch (error) {
      // Not archived (uncommitted work, say): the thread carries on with what it has queued.
      this.#archiving.delete(thread.id);
      this.#pump(thread.id);
      throw error;
    }
    clearPrompts(this.store, thread.id);
    for (const change of dismissItems(this.store, thread.id)) this.#emit({ type: "item", change });
    return this.#changed(thread.id);
  }

  threads(filter: { project?: string; includeArchived?: boolean } = {}): ThreadView[] {
    const projectId = filter.project ? findProject(this.store, filter.project).id : undefined;
    return listThreads(this.store, {
      ...(projectId ? { projectId } : {}),
      includeArchived: filter.includeArchived ?? false,
    }).map((t) => this.#viewOf(t));
  }

  view(threadId: string): ThreadView {
    return this.#viewOf(getThread(this.store, threadId));
  }

  events(threadId: string, after = 0): { thread: ThreadView; events: StoredEvent[] } {
    const thread = getThread(this.store, threadId);
    return { thread: this.#viewOf(thread), events: threadEvents(this.store, thread.id, after) };
  }

  snapshot(): Snapshot {
    return {
      environmentId: this.store.environmentId,
      threads: this.threads(),
      items: openItems(this.store),
    };
  }

  /**
   * Answers an item. If the agent is still waiting, the answer goes straight to it. If the
   * process that asked has ended (a crash, a daemon restart), the item is resolved here and the
   * answer is queued as a message to the resumed session (answers.ts), which then carries on.
   */
  async answer(
    itemId: string,
    answer: ItemAnswer,
  ): Promise<{ item: QueueItem; delivery: "live" | "message"; thread: ThreadView }> {
    const item = getItem(this.store, itemId);
    if (!item) throw new TenzoError(`No item "${itemId}". \`tenzo items\` lists the open ones.`);
    if (item.status !== "open") {
      throw new TenzoError(`${item.id} is no longer open (${item.resolution?.kind ?? "resolved"}).`);
    }
    if (this.#answering.has(item.id)) throw new TenzoError(`${item.id} is being answered already.`);
    const thread = this.#active(item.threadId);
    const checked = checkAnswer(item, answer);

    const live = this.#live.get(thread.id);
    if (!item.detached && live) {
      const resolved = this.#waitForResolution(item.id);
      try {
        respond(live.session, item.requestId, checked);
      } catch (error) {
        resolved.cancel();
        // Not waiting any more: the session ended a moment ago. Deliver it as a message.
        if (!(error instanceof TenzoError)) throw error;
      }
      if (!resolved.cancelled) {
        const done = await resolved.promise;
        return { item: done ?? item, delivery: "live", thread: this.view(thread.id) };
      }
    }

    this.#append(
      draft(thread, {
        ...(item.turnId ? { turnId: item.turnId } : {}),
        ...(checked.kind === "question"
          ? {
              type: "user-input.resolved",
              requestId: item.requestId,
              payload: { answers: checked.answers, cancelled: false },
            }
          : {
              type: "request.resolved",
              requestId: item.requestId,
              payload: {
                decision: checked.decision,
                ...(checked.message ? { message: checked.message } : {}),
              },
            }),
      } as Draft),
    );
    enqueuePrompt(
      this.store,
      thread.id,
      deliveryPrompt(item, checked),
      standingReply(item, checked),
    );
    this.#pump(thread.id);
    return {
      item: getItem(this.store, item.id) ?? item,
      delivery: "message",
      thread: this.#changed(thread.id),
    };
  }

  /** Stops every session, leaving open items for the next daemon. */
  async close(): Promise<void> {
    this.#closing = true;
    await Promise.all(
      [...this.#live.values()].map(async (live) => {
        await live.session.stop();
        await live.reading;
      }),
    );
  }

  // Internals.

  /** Sends the thread's next queued prompt if no turn of ours is running, starting the agent. */
  #pump(threadId: ThreadId): void {
    if (this.#closing || this.#archiving.has(threadId)) return;
    const thread = getThread(this.store, threadId);
    if (thread.status !== "active") return;
    let live = this.#live.get(threadId);
    if (live?.turnId) return;
    const prompt = nextPrompt(this.store, threadId);
    if (!prompt) return;

    if (!live) {
      try {
        live = this.#startSession(thread);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const waiting = queuedCount(this.store, threadId);
        clearPrompts(this.store, threadId);
        this.#append(
          draft(thread, {
            type: "runtime.error",
            payload: {
              message: `Couldn't start ${thread.agent ?? "claude"}: ${message} (${waiting} prompt(s) not sent)`,
            },
          }),
        );
        this.#changed(threadId);
        return;
      }
    }

    let turnId: TurnId;
    try {
      turnId = live.session.sendTurn(prompt.text);
    } catch (error) {
      // The session is ending; when it has, #read starts a new one for this prompt.
      if (error instanceof TenzoError) return;
      throw error;
    }
    removePrompt(this.store, prompt.seq);
    live.turnId = turnId;
    live.standing = prompt.reply ? [prompt.reply] : [];
  }

  #startSession(thread: Thread): Live {
    const agent = thread.agent ?? "claude";
    const adapter = this.#adapters[agent];
    if (!adapter) throw new TenzoError(`No ${agent} adapter.`);
    const session = adapter.start({
      threadId: thread.id,
      cwd: thread.worktreePath,
      ...(thread.sessionId ? { resumeSessionId: thread.sessionId } : {}),
      ...(thread.model ? { model: thread.model } : {}),
    });
    const live: Live = {
      threadId: thread.id,
      session,
      turnId: null,
      standing: [],
      reading: Promise.resolve(),
    };
    this.#live.set(thread.id, live);
    live.reading = this.#read(live);
    return live;
  }

  async #read(live: Live): Promise<void> {
    try {
      for await (const event of live.session.events) {
        try {
          this.#ingest(live, event);
        } catch (error) {
          this.#log(`couldn't store a ${event.type} event of ${live.threadId}: ${String(error)}`);
        }
      }
    } finally {
      if (this.#live.get(live.threadId) === live) this.#live.delete(live.threadId);
      // An agent that ended without saying so must not look alive.
      if (loadFoldState(this.store, live.threadId).runtime.live) {
        this.#append(
          draft(getThread(this.store, live.threadId), {
            type: "session.exited",
            payload: { exitKind: "error", reason: "The agent's event stream ended." },
          }),
        );
      }
      this.#changed(live.threadId);
      // Prompts that came in while it was ending start a new session.
      this.#pump(live.threadId);
    }
  }

  #ingest(live: Live, event: RuntimeEvent): void {
    this.#append(event);
    switch (event.type) {
      case "user-input.requested":
      case "request.opened": {
        const fingerprint = requestFingerprint(event);
        const index = live.standing.findIndex((r) => r.fingerprint === fingerprint);
        if (index === -1) break;
        const [reply] = live.standing.splice(index, 1);
        if (reply) {
          try {
            respond(live.session, event.requestId, reply);
          } catch (error) {
            if (!(error instanceof TenzoError)) throw error;
          }
        }
        break;
      }
      case "turn.completed":
        if (event.turnId === live.turnId) {
          live.turnId = null;
          live.standing = [];
          this.#pump(live.threadId);
        }
        this.#changed(live.threadId);
        break;
      case "turn.started":
      case "session.exited":
        this.#changed(live.threadId);
        break;
    }
  }

  #append(event: RuntimeEvent): void {
    const { seq, changes } = appendEvent(this.store, event);
    this.#emit({ type: "event", seq, environmentId: this.store.environmentId, event });
    for (const change of changes) {
      this.#emit({ type: "item", change });
      if (change.type === "resolved") {
        const waiter = this.#answering.get(change.item.id);
        this.#answering.delete(change.item.id);
        waiter?.(change.item);
      }
    }
    if (changes.length > 0) this.#changed(event.threadId);
  }

  #waitForResolution(itemId: QueueItemId) {
    let timer: NodeJS.Timeout | undefined;
    const state = {
      cancelled: false,
      promise: undefined as unknown as Promise<QueueItem | undefined>,
      cancel: () => {},
    };
    state.promise = new Promise<QueueItem | undefined>((resolve) => {
      const settle = (item: QueueItem | undefined) => {
        clearTimeout(timer);
        if (this.#answering.get(itemId) === settle) this.#answering.delete(itemId);
        resolve(item);
      };
      this.#answering.set(itemId, settle);
      timer = setTimeout(() => settle(undefined), this.#answerTimeoutMs);
      state.cancel = () => {
        state.cancelled = true;
        settle(undefined);
      };
    });
    return state;
  }

  #active(threadId: string): Thread {
    const thread = getThread(this.store, threadId);
    if (thread.status !== "active") throw new TenzoError(`${thread.id} is archived.`);
    return thread;
  }

  /** The thread as it is now, told to subscribers. */
  #changed(threadId: ThreadId): ThreadView {
    const view = this.view(threadId);
    this.#emit({ type: "thread", thread: view });
    return view;
  }

  #viewOf(thread: Thread): ThreadView {
    const runtime = loadFoldState(this.store, thread.id).runtime;
    const queued = queuedCount(this.store, thread.id);
    const open = openItems(this.store, thread.id).length;
    const live = this.#live.get(thread.id);
    const working =
      thread.status === "active" &&
      (queued > 0 || Boolean(live?.turnId) || (runtime.live && runtime.turnId !== null));
    return {
      id: thread.id,
      environmentId: thread.environmentId,
      projectId: thread.projectId,
      projectName: projectOf(this.store, thread).name,
      title: thread.title,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      status: thread.status,
      agent: runtime.agent ?? thread.agent,
      model: thread.model,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      archivedAt: thread.archivedAt,
      activity: open > 0 ? "needs-you" : working ? "working" : "idle",
      working,
      queued,
      openItems: open,
      lastSeq: lastSeq(this.store, thread.id),
    };
  }

  #emit(change: EngineChange): void {
    for (const listener of this.#listeners) {
      try {
        listener(change);
      } catch (error) {
        this.#log(`a subscriber failed: ${String(error)}`);
      }
    }
  }
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Draft = DistributiveOmit<RuntimeEvent, "eventId" | "threadId" | "agent" | "createdAt">;

/** An event the daemon records itself, about a thread whose agent isn't saying it. */
function draft(thread: Thread, event: Draft): RuntimeEvent {
  return {
    ...event,
    eventId: randomId("evt"),
    threadId: thread.id,
    agent: thread.agent ?? "claude",
    createdAt: new Date().toISOString(),
  } as RuntimeEvent;
}

function respond(
  session: AgentSession,
  requestId: QueueItem["requestId"],
  answer: ItemAnswer | StandingReply,
): void {
  if (answer.kind === "question") session.respondToUserInput(requestId, answer.answers);
  else session.respondToRequest(requestId, answer.decision, answer.message);
}
