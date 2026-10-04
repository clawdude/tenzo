import {
  type AgentKind,
  type ItemAnswer,
  type LiveInfo,
  Preview,
  type ProjectView,
  type QueueItem,
  type QueueItemId,
  type RuntimeEvent,
  type Snapshot,
  type StoredEvent,
  type ThreadId,
  type ThreadView,
  type TurnId,
} from "@tenzo/contracts";
import type { AgentAdapter, AgentSession } from "./agent/agent.ts";
import { attachmentsDir, removeAttachments, removeCopies } from "./attachments.ts";
import {
  checkAnswer,
  deliveryPrompt,
  isAsk,
  matchReply,
  type StandingReply,
  standingReply,
} from "./answers.ts";
import { TenzoError } from "./errors.ts";
import {
  type Appended,
  appendEvent,
  clearPrompts,
  enqueuePrompt,
  getItem,
  lastEvent,
  liveThreads,
  loadFoldState,
  nextPrompt,
  openItems,
  queuedCount,
  removePrompt,
  threadEvents,
  threadsWithPrompts,
} from "./event-store.ts";
import { type ItemChange, itemIdFor } from "./fold.ts";
import { randomId } from "./ids.ts";
import { findProject, listProjects } from "./projects.ts";
import { loadThreadPrompts, type ThreadPrompts } from "./prompts.ts";
import { type Store, transaction } from "./store.ts";
import {
  archiveThread,
  checkArchivable,
  createThread,
  finishNaming,
  getThread,
  listThreads,
  projectOf,
  type Thread,
  threadByClientKey,
  threadsToName,
} from "./threads.ts";
import { quickTitle, type Titler } from "./titles.ts";

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
  /**
   * Names a thread started from a prompt without a title, after it has started (titles.ts).
   * Without one, threads keep the prompt's first words.
   */
  titler?: Titler;
  /** The model for threads started without one (`TENZO_DEFAULT_MODEL`). Default: the agent's. */
  defaultModel?: string;
  /**
   * Tenzo's thread prompts, read as each session starts so an edit applies to the next one.
   * Default: the files in `apps/daemon/prompts` (prompts.ts).
   */
  prompts?: () => ThreadPrompts;
  log?: (message: string) => void;
}

/** `thread.create`'s arguments (see the command in contracts). */
export interface NewThread {
  project: string;
  title?: string;
  prompt?: string;
  model?: string;
  clientKey?: string;
}

/** What a `thread.create` asked for, to tell a retry (the same) from a reused key (not). */
function createRequest(input: NewThread): string {
  return JSON.stringify([
    input.project,
    input.title?.trim() ?? "",
    input.prompt?.trim() ?? "",
    input.model ?? "",
  ]);
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
  /** Items answered for you from a standing reply: subscribers never see them open. */
  readonly #quiet = new Set<QueueItemId>();
  readonly #titler: Titler | undefined;
  readonly #defaultModel: string | undefined;
  readonly #prompts: () => ThreadPrompts;
  /** Names being thought of; `close` stops and waits for them. */
  readonly #naming = new Set<Promise<void>>();
  readonly #stopNaming = new AbortController();
  /** Creates under way, by client key: a retry that comes in meanwhile waits for the same one. */
  readonly #creating = new Map<string, { request: string; thread: Promise<ThreadView> }>();
  #closing = false;
  #liveInfo: LiveInfo | null = null;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.#adapters = options.adapters;
    this.#answerTimeoutMs = options.answerTimeoutMs ?? 10_000;
    this.#titler = options.titler;
    this.#defaultModel = options.defaultModel;
    this.#prompts = options.prompts ?? (() => loadThreadPrompts());
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
    // Names the last daemon stopped thinking of before it had one.
    for (const { id, prompt } of threadsToName(this.store)) this.#name(id, prompt);
  }

  subscribe(listener: (change: EngineChange) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * A new thread. With a `clientKey`, a create the daemon has made (or is making) under that key
   * answers with that thread instead: a client's retry never makes a second one. The same key
   * with another request (project, title, prompt or model) is a client bug, and is refused.
   */
  async createThread(input: NewThread): Promise<ThreadView> {
    const key = input.clientKey;
    if (key === undefined) return this.#create(input);
    const request = createRequest(input);
    const made = threadByClientKey(this.store, key);
    const pending = this.#creating.get(key);
    const seen = made?.request ?? pending?.request;
    if (seen !== undefined && seen !== request) {
      throw new TenzoError(
        `Client key "${key}" was already used for another thread.create (a different project, title, prompt or model). A new request needs a new key.`,
      );
    }
    if (made) return this.view(made.thread.id);
    if (pending) return pending.thread;
    const thread = this.#create(input, { key, request }).finally(() => this.#creating.delete(key));
    this.#creating.set(key, { request, thread });
    return thread;
  }

  async #create(input: NewThread, client?: { key: string; request: string }): Promise<ThreadView> {
    const prompt = input.prompt?.trim();
    const given = input.title?.trim();
    // Without a title, the prompt's first words stand in until the titler has a name.
    const title = given || (prompt ? quickTitle(prompt) : "");
    if (title === "") throw new TenzoError("A new thread needs a title or a prompt.");
    const model = input.model ?? this.#defaultModel;
    const thread = await createThread(this.store, input.project, title, {
      ...(model ? { model } : {}),
      ...(prompt && !given ? { naming: prompt } : {}),
      ...(client ? { client } : {}),
    });
    if (prompt) enqueuePrompt(this.store, thread.id, prompt);
    this.#pump(thread.id);
    const view = this.#changed(thread.id);
    if (prompt && !given) this.#name(thread.id, prompt);
    return view;
  }

  /** The registered projects, by name: where a new thread can start. */
  projects(): ProjectView[] {
    return listProjects(this.store).map((p) => ({
      id: p.id,
      environmentId: p.environmentId,
      name: p.name,
      defaultBranch: p.defaultBranch,
    }));
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
    // Refuse before stopping anything: a refused archive must not kill the running turn.
    await checkArchivable(this.store, thread, options);
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
    await removeAttachments(this.store.home, thread.id).catch((error: unknown) => {
      this.#log(`couldn't remove the attachments of ${thread.id}: ${String(error)}`);
    });
    // Through the log, so folding it gives the dismissed items too.
    this.#append(draft(getThread(this.store, thread.id), { type: "thread.archived", payload: {} }));
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

  /**
   * The port an active thread's live base goes to: the dev server its agent exposed last, or
   * null (live.ts). Only that thread's port, never one named by a request.
   */
  livePort(threadId: string): number | null {
    // Every request a live page makes comes through here: one row, one column.
    const row = this.store.db
      .prepare("SELECT preview FROM threads WHERE id = ? AND status = 'active'")
      .get(threadId);
    if (!row || row.preview === null) return null;
    const preview = Preview.safeParse(JSON.parse(String(row.preview)));
    return preview.success ? preview.data.port : null;
  }

  /** Where threads' live apps are served; the daemon sets it once its live listener is up. */
  setLive(live: LiveInfo | null): void {
    this.#liveInfo = live;
  }

  events(threadId: string, after = 0): { thread: ThreadView; events: StoredEvent[] } {
    const thread = getThread(this.store, threadId);
    return { thread: this.#viewOf(thread), events: threadEvents(this.store, thread.id, after) };
  }

  snapshot(): Snapshot {
    return {
      environmentId: this.store.environmentId,
      threads: this.threads(),
      items: openItems(this.store).filter((i) => !this.#quiet.has(i.id)),
      projects: this.projects(),
      live: this.#liveInfo,
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
  ): Promise<{ item: QueueItem; delivery: "live" | "message" | "none"; thread: ThreadView }> {
    const item = getItem(this.store, itemId);
    if (!item) throw new TenzoError(`No item "${itemId}". \`tenzo items\` lists the open ones.`);
    if (item.status !== "open") {
      throw new TenzoError(`${item.id} is no longer open (${item.resolution?.kind ?? "resolved"}).`);
    }
    if (this.#answering.has(item.id)) throw new TenzoError(`${item.id} is being answered already.`);
    const thread = this.#active(item.threadId);
    const checked = checkAnswer(item, answer);
    if (checked.kind === "finished") {
      // Nothing waits on a report: the daemon records your answer, and that is all (#21 adds the
      // review actions that go back to the agent).
      this.#append(
        draft(thread, {
          type: "report.resolved",
          requestId: item.requestId,
          payload: { decision: checked.decision },
        }),
      );
      return {
        item: getItem(this.store, item.id) ?? item,
        delivery: "none",
        thread: this.#changed(thread.id),
      };
    }

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
        if (done) return { item: done, delivery: "live", thread: this.view(thread.id) };
        // No confirmation. If the session ended meanwhile, deliver it as a message after all;
        // otherwise report the item as it stands (still open), not as answered.
        const now = getItem(this.store, item.id) ?? item;
        if (now.status !== "open" || !now.detached) {
          return { item: now, delivery: "live", thread: this.view(thread.id) };
        }
      }
    }

    const reply = standingReply(item, checked);
    const resolution = draft(thread, {
      ...(item.turnId ? { turnId: item.turnId } : {}),
      ...resolutionOf(item, checked),
    } as Draft);
    // Both or neither: a crash in between must not leave the item answered and the answer unsent.
    const appended = transaction(this.store, () => {
      const result = appendEvent(this.store, resolution);
      enqueuePrompt(this.store, thread.id, deliveryPrompt(item, checked), reply);
      return result;
    });
    this.#publish(resolution, appended);
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
    this.#stopNaming.abort();
    await Promise.all([
      ...[...this.#live.values()].map(async (live) => {
        await live.session.stop();
        await live.reading;
      }),
      ...this.#naming,
    ]);
  }

  // Internals.

  /**
   * Asks the titler for the thread's name, in the background: the thread has started already.
   * A name that comes back replaces the stand-in and is announced; no name (or an error) leaves
   * the stand-in, quietly, for good. Only a daemon stopping mid-naming leaves it to the next one.
   */
  #name(threadId: ThreadId, prompt: string): void {
    const titler = this.#titler;
    if (!titler) return;
    const naming = (async () => {
      let title: string | null = null;
      try {
        title = await titler(prompt, this.#stopNaming.signal);
      } catch {
        // A name is a nicety; the stand-in stays.
      }
      if (this.#closing) return; // stopped mid-naming: the next daemon asks again
      try {
        if (getThread(this.store, threadId).status !== "active") return;
        finishNaming(this.store, threadId, title);
        if (title) this.#changed(threadId);
      } catch (error) {
        this.#log(`couldn't name ${threadId}: ${String(error)}`);
      }
    })();
    this.#naming.add(naming);
    void naming.finally(() => this.#naming.delete(naming));
  }

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
      ...(() => {
        const runtime = loadFoldState(this.store, thread.id).runtime;
        // The attach cap counts what this thread already holds for its next report.
        return { phase: runtime.phase, pendingAttachments: runtime.attachments.length };
      })(),
      prompts: this.#prompts(),
      attachmentsDir: attachmentsDir(this.store.home, thread.id),
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
    if (isAsk(event)) {
      const index = matchReply(live.standing, event);
      const [reply] = index === -1 ? [] : live.standing.splice(index, 1);
      if (reply) {
        // Answered for you from your earlier answer: logged, but never shown as a card.
        const itemId = itemIdFor(event.requestId);
        this.#quiet.add(itemId);
        this.#append(event);
        try {
          respond(live.session, event.requestId, reply);
        } catch (error) {
          if (!(error instanceof TenzoError)) throw error;
          // It didn't reach the agent: the item is yours after all, so show it.
          this.#unquiet(itemId);
        }
        return;
      }
    }
    this.#append(event);
    switch (event.type) {
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
    this.#publish(event, appendEvent(this.store, event));
  }

  /** Tells subscribers what an appended event did, once it is stored. */
  #publish(event: RuntimeEvent, { seq, changes }: Appended): void {
    this.#emit({ type: "event", seq, environmentId: this.store.environmentId, event });
    let announced = false;
    for (const change of changes) {
      if (this.#quiet.has(change.item.id)) {
        // Being answered for you: silent while it opens and when it resolves. If it is left
        // open instead (the agent ended first), it becomes an ordinary item and is shown.
        if (change.type === "opened") continue;
        this.#quiet.delete(change.item.id);
        if (change.type === "resolved") continue;
        this.#emit({ type: "item", change: { type: "opened", item: change.item } });
      } else {
        this.#emit({ type: "item", change });
      }
      announced = true;
      if (change.type === "resolved") {
        const waiter = this.#answering.get(change.item.id);
        this.#answering.delete(change.item.id);
        waiter?.(change.item);
        if (change.item.resolution?.kind === "superseded") this.#dropCopies(change.item);
      }
    }
    if (announced) this.#changed(event.threadId);
  }

  /** A replaced report's screenshots: nothing shows them any more, so their copies go. */
  #dropCopies(item: QueueItem): void {
    const files = item.finished?.attachments.map((a) => a.file) ?? [];
    if (files.length === 0) return;
    void removeCopies(this.store.home, item.threadId, files).catch((error: unknown) => {
      this.#log(`couldn't remove the screenshots of ${item.id}: ${String(error)}`);
    });
  }

  /** Shows an item that was being answered for you, as it now stands. */
  #unquiet(itemId: QueueItemId): void {
    if (!this.#quiet.delete(itemId)) return;
    const item = getItem(this.store, itemId);
    if (item?.status !== "open") return;
    this.#emit({ type: "item", change: { type: "opened", item } });
    this.#changed(item.threadId);
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
    // An item being answered for you doesn't make the thread need you, not even for a moment.
    const open = openItems(this.store, thread.id).filter((i) => !this.#quiet.has(i.id)).length;
    const live = this.#live.get(thread.id);
    const working =
      thread.status === "active" &&
      (queued > 0 || Boolean(live?.turnId) || (runtime.live && runtime.turnId !== null));
    const last = lastEvent(this.store, thread.id);
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
      phase: runtime.phase,
      activity: open > 0 ? "needs-you" : working ? "working" : "idle",
      working,
      queued,
      openItems: open,
      lastSeq: last?.seq ?? 0,
      activeAt: last?.at ?? thread.createdAt,
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

/** An answer that goes to the agent: everything but finished work's. */
type AgentAnswer = Exclude<ItemAnswer, { kind: "finished" }>;

function respond(
  session: AgentSession,
  requestId: QueueItem["requestId"],
  answer: AgentAnswer | StandingReply,
): void {
  switch (answer.kind) {
    case "question":
      return session.respondToUserInput(requestId, answer.answers);
    case "permission":
      return session.respondToRequest(requestId, answer.decision, answer.message);
    case "proposal":
      return session.respondToProposal(requestId, answer.decision, answer.note);
  }
}

/** The event that records an answer the daemon delivers itself (the agent had stopped). */
function resolutionOf(item: QueueItem, answer: AgentAnswer): Draft {
  const requestId = item.requestId;
  switch (answer.kind) {
    case "question":
      return {
        type: "user-input.resolved",
        requestId,
        payload: { answers: answer.answers, cancelled: false },
      };
    case "permission":
      return {
        type: "request.resolved",
        requestId,
        payload: {
          decision: answer.decision,
          ...(answer.message ? { message: answer.message } : {}),
        },
      };
    case "proposal":
      return {
        type: "proposal.resolved",
        requestId,
        payload: { decision: answer.decision, ...(answer.note ? { note: answer.note } : {}) },
      };
  }
}
