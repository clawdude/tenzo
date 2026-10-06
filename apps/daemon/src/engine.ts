import { existsSync } from "node:fs";
import {
  type AgentKind,
  type AutomationRunView,
  type AutomationsState,
  type AutomationView,
  type ItemAnswer,
  ModelName,
  type LiveInfo,
  MAX_EVENT_PAGE,
  Preview,
  type ProjectView,
  type QueueItem,
  type QueueItemId,
  type RuntimeEvent,
  type Snapshot,
  type StoredEvent,
  type ThinkingLevel,
  type ThreadDiff,
  type ThreadId,
  type ThreadView,
  type TurnId,
} from "@tenzo/contracts";
import type { AgentAdapter, AgentSession, SessionSettings } from "./agent/agent.ts";
import { attachmentsDir, removeAttachments, removeCopies } from "./attachments.ts";
import {
  activeRunsOf,
  activeRunThreads,
  type AutomationRun,
  Automations,
  finishRun,
  insertRun,
  grantMore,
  recordCost,
  type RunBudget,
  type RunStart,
  runOfThread,
  runThreadOptions,
  unfinishedRuns,
} from "./automations.ts";
import {
  checkAnswer,
  deliveryPrompt,
  errorPrompts,
  RESTART_PROMPT,
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
  configCards,
  countEventsAfter,
  enqueuePrompt,
  eventPage,
  getItem,
  hasLanded,
  landedThreads,
  lastEvent,
  liveThreads,
  loadFoldState,
  nextPrompt,
  openItems,
  queuedCount,
  queuedPrompts,
  removePrompt,
  threadEvents,
  threadsToWake,
  threadsWithPrompts,
} from "./event-store.ts";
import { diffStat } from "./diff.ts";
import { errorMessage, type ItemChange, isLandingCause, itemIdFor, waitsOnYou } from "./fold.ts";
import { branchExists, commitsAhead, hasChanges, landedOn, resolveBase, stopDetachedGit } from "./git.ts";
import { randomId } from "./ids.ts";
import {
  automationsOf,
  type ConfigRead,
  landingOf,
  permissionsOf,
  ProjectConfigs,
  resolveModels,
} from "./project-config.ts";
import { findProject, listProjects } from "./projects.ts";
import {
  loadThreadPrompts,
  mergePrompt,
  reviewPrompt,
  STALLED_PROMPT,
  type ThreadPrompts,
  wakePrompt,
} from "./prompts.ts";
import { type Store, transaction } from "./store.ts";
import {
  activeAgentThreads,
  archiveThread,
  checkArchivable,
  countChildren,
  createThread,
  finishNaming,
  getThread,
  listThreads,
  projectOf,
  setThreadModel,
  type Thread,
  threadByClientKey,
  threadsToName,
} from "./threads.ts";
import { Timers } from "./timers.ts";
import { quickTitle, type Titler } from "./titles.ts";

/** Threads one thread may start with `start_thread`, ever: enough for real work, no runaway loop. */
export const MAX_CHILD_THREADS = 10;
/** Threads started by agents that may be active at once, across every thread. */
export const MAX_AGENT_THREADS = 10;

/**
 * What a landed thread's stuck card adds: Retry gives it work, but it stays marked landed, so it
 * archives anyway once a turn of its ends (or the daemon restarts). New work goes in a new thread.
 */
export const STILL_LANDED =
  "It's already marked landed, so it archives at its next turn end or when Tenzo restarts: start a new thread for more work.";

/** `text` ending as a sentence does, so another can follow it (git's errors mostly don't). */
export function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** A duration in a word or two: "45s", "12m", "2h 5m", "1d 3h". */
export function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

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
  /**
   * The model for threads whose project's config names none (`TENZO_DEFAULT_MODEL`). Default:
   * the agent's own.
   */
  defaultModel?: string;
  /**
   * Tenzo's thread prompts, read as each session starts so an edit applies to the next one.
   * Default: the files in `apps/daemon/prompts` (prompts.ts).
   */
  prompts?: () => ThreadPrompts;
  /** How long a swipe snoozes an item. Default 15 minutes; `TENZO_SNOOZE_MS` for trying it. */
  snoozeMs?: number;
  /**
   * How long the next turn waits for the agent to switch model or thinking, and for a session
   * to end when it is restarted to change its settings. Default 15 s.
   */
  switchTimeoutMs?: number;
  /** How often the automations' scheduler looks at the configs when nothing is due sooner. */
  automationTickMs?: number;
  log?: (message: string) => void;
}

/** How long a swipe snoozes an item (PRODUCT.md §5). */
export const SNOOZE_MS = 15 * 60_000;

/** `thread.create`'s arguments (see the command in contracts). */
export interface NewThread {
  project: string;
  title?: string;
  prompt?: string;
  model?: string;
  clientKey?: string;
  /** The thread whose agent starts this one (`start_thread`): its origin is then `agent`. */
  parent?: ThreadId;
  /** The automation run this thread is (automations.ts): its origin is then `automation`. */
  run?: Omit<RunStart, "title" | "prompt">;
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

/** How many of its latest events a client gets when it starts watching a thread. */
export const WATCH_BACKLOG = 200;

/** What subscribers hear: each event as stored, each item change, each thread change. */
export type EngineChange =
  | ({ type: "event" } & StoredEvent)
  | { type: "item"; change: ItemChange }
  | { type: "thread"; thread: ThreadView }
  | { type: "automations"; automations: AutomationsState };

interface Live {
  threadId: ThreadId;
  session: AgentSession;
  /** The turn of the prompt we sent last, until it completes. One at a time. */
  turnId: TurnId | null;
  /** Answers to give, instead of asking again, if the agent repeats an ask in this turn. */
  standing: StandingReply[];
  /** Ends when the session's events do. */
  reading: Promise<void>;
  /** The agent said its work landed (`landed`): the thread archives when the turn ends. */
  landed: boolean;
  /** Ending at a turn boundary to start again with new settings: nothing more is sent to it. */
  restarting: boolean;
  /** Switching model or thinking in place: the next turn waits for it. */
  switching: boolean;
  /** Let go of (it wouldn't end): nothing it still says reaches the log. */
  abandoned: boolean;
  /** Started to change the thread's settings (`#restartSession`): never restarted for a timeout. */
  restarted: boolean;
  /** The next turn goes without asking the session to switch first (a switch timed out). */
  asIs: boolean;
  /** What the session's turns cost and how long they waited on you (`measureTurn`). */
  clock: TurnClock;
}

/** A session's running figures, to give each `turn.completed` what that turn alone took. */
interface TurnClock {
  /** The agent's running total at its last turn's end (it starts again at 0 with each session). */
  spentUsd: number;
  /** Asks open now (a question, a permission, a proposal), by request id. */
  asking: Set<string>;
  /** Since when at least one ask has been open, in ms; null while none is. */
  waitingSince: number | null;
  /** How long the current turn has waited on you so far, in ms. */
  waitedMs: number;
}

const RESOLVES_ASK = new Set<RuntimeEvent["type"]>([
  "user-input.resolved",
  "request.resolved",
  "proposal.resolved",
]);

/**
 * Keeps `clock` up to date with `event`, and gives a `turn.completed` the turn's own cost (the
 * agent reports its session's running total) and how long it waited on you (the agent's
 * duration counts that too). By the events' own times.
 */
export function measureTurn(clock: TurnClock, event: RuntimeEvent): RuntimeEvent {
  const at = Date.parse(event.createdAt);
  const pause = () => {
    if (clock.waitingSince !== null) clock.waitedMs += Math.max(0, at - clock.waitingSince);
    clock.waitingSince = null;
  };
  if (isAsk(event)) {
    if (clock.asking.size === 0) clock.waitingSince = at;
    clock.asking.add(event.requestId);
  } else if (RESOLVES_ASK.has(event.type) && "requestId" in event) {
    if (clock.asking.delete(event.requestId) && clock.asking.size === 0) pause();
  } else if (event.type === "turn.started") {
    clock.waitedMs = 0;
    clock.waitingSince = clock.asking.size > 0 ? at : null;
  } else if (event.type === "turn.completed") {
    pause();
    const waitedMs = clock.waitedMs;
    clock.waitedMs = 0;
    clock.waitingSince = clock.asking.size > 0 ? at : null;
    const { costUsd } = event.payload;
    let turnCostUsd: number | undefined;
    if (costUsd !== undefined) {
      // A total lower than the last one is a new count (the agent started again).
      turnCostUsd = round(costUsd >= clock.spentUsd ? costUsd - clock.spentUsd : costUsd);
      clock.spentUsd = costUsd;
    }
    return {
      ...event,
      payload: { ...event.payload, ...(turnCostUsd === undefined ? {} : { turnCostUsd }), waitedMs },
    };
  }
  return event;
}

/** Rounded to a millionth of a dollar: what subtracting two totals leaves is noise below that. */
function round(usd: number): number {
  return Math.round(usd * 1e6) / 1e6;
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
  /** Threads whose session the daemon ended to change its settings: the next one says so. */
  readonly #restarted = new Set<ThreadId>();
  /** Projects' `.tenzo/` configs, read again whenever their files change (project-config.ts). */
  readonly #configs = new ProjectConfigs();
  /** Names being thought of; `close` stops and waits for them. */
  readonly #naming = new Set<Promise<void>>();
  readonly #stopNaming = new AbortController();
  /** Creates under way, by client key: a retry that comes in meanwhile waits for the same one. */
  readonly #creating = new Map<string, { request: string; thread: Promise<ThreadView> }>();
  /** Landed threads being archived: nothing new is sent to them meanwhile. */
  readonly #landing = new Set<ThreadId>();
  /** `start_thread` calls under way, by parent: they count against the limits already. */
  readonly #startingChildren = new Map<ThreadId, number>();
  readonly #snoozeMs: number;
  readonly #switchTimeoutMs: number;
  /** A timer per snoozed item, to bring it back when its time comes. */
  readonly #snoozes = new Timers<QueueItemId>();
  /** A timer per thread whose agent asked to be woken (`wake_me`). */
  readonly #wakes = new Timers<ThreadId>();
  /** A timer per automation run with a wall-clock budget: its deadline. */
  readonly #budgets = new Timers<ThreadId>();
  /** The projects' automations: their schedules and runs (automations.ts). */
  readonly #automations: Automations;
  /** A look at the automations is due (`#automationsChanged`): changes in one tick go as one. */
  #automationsTimer: NodeJS.Timeout | undefined;
  /** What subscribers last heard of the automations, so the same list isn't sent twice. */
  #automationsSent: string | null = null;
  /** Each look at the automations, numbered: only the latest one's list is sent. */
  #automationsLook = 0;
  /** Finished runs whose worktree had uncommitted changes when last looked at. */
  readonly #dirty = new Set<ThreadId>();
  #closing = false;
  #liveInfo: LiveInfo | null = null;

  constructor(options: EngineOptions) {
    this.store = options.store;
    this.#adapters = options.adapters;
    this.#answerTimeoutMs = options.answerTimeoutMs ?? 10_000;
    this.#titler = options.titler;
    this.#defaultModel = options.defaultModel;
    this.#prompts = options.prompts ?? (() => loadThreadPrompts());
    this.#snoozeMs = options.snoozeMs ?? SNOOZE_MS;
    this.#switchTimeoutMs = options.switchTimeoutMs ?? 15_000;
    this.#log = options.log ?? ((message) => console.error(`tenzo: ${message}`));
    this.#automations = new Automations(
      {
        store: this.store,
        config: (root) => this.#readConfig(root),
        start: (run) =>
          this.#create({ project: run.project.name, title: run.title, prompt: run.prompt, run }),
        state: (threadId) => this.#runState(threadId),
        clean: (threadId) => !this.#dirty.has(threadId),
        retire: (threadId) => this.#retireRun(threadId),
        changed: () => this.#automationsChanged(),
        log: this.#log,
      },
      { ...(options.automationTickMs ? { tickMs: options.automationTickMs } : {}) },
    );
  }

  /**
   * Picks up where the last daemon left off. Sessions it was running are gone with it: their
   * open items become detached (answering them resumes the session), and prompts still queued
   * are sent, resuming their threads.
   */
  start(): void {
    // Sessions the last daemon didn't get to stop (it was killed). A turn they were in the
    // middle of picks up again with RESTART_PROMPT, once: if that resumed turn was itself cut
    // short like this, it gets an error card instead, so a daemon dying in a loop can't keep
    // resuming it.
    for (const threadId of liveThreads(this.store)) {
      const thread = getThread(this.store, threadId);
      const again = loadFoldState(this.store, threadId).runtime.prompt === RESTART_PROMPT;
      const resume = this.#cutShort(threadId) && !again;
      const exited = draft(thread, {
        type: "session.exited",
        payload: resume
          ? { exitKind: "graceful", reason: "Tenzo stopped while this session was running." }
          : {
              exitKind: "error",
              reason: again
                ? "Tenzo stopped twice while this turn ran, so it wasn't resumed again."
                : "Tenzo stopped while this session was running.",
            },
      });
      // Both or neither: a kill in between must not queue the resume twice.
      const appended = transaction(this.store, () => {
        if (resume) this.#resumeLater(threadId);
        return appendEvent(this.store, exited);
      });
      this.#publish(exited, appended);
    }
    // Threads that landed while the last daemon ran go first, so nothing queued for them starts
    // a session. One with a landing card already waits for you instead.
    for (const threadId of landedThreads(this.store)) {
      const stuck = openItems(this.store, threadId).some(
        (item) => item.kind === "error" && isLandingCause(item.error?.cause),
      );
      if (!stuck) this.#archiveLanded(threadId);
    }
    for (const threadId of threadsWithPrompts(this.store)) this.#pump(threadId);
    // Names the last daemon stopped thinking of before it had one.
    for (const { id, prompt } of threadsToName(this.store)) this.#name(id, prompt);
    // Wakes the agents asked for come on time across restarts; any whose time passed, now.
    for (const threadId of threadsToWake(this.store)) this.#armWake(threadId);
    // Snoozed items come back on time across restarts; any whose time came meanwhile, now.
    for (const item of openItems(this.store)) if (item.snoozedUntil) this.#armSnooze(item);
    // Automation runs keep their budgets across restarts; schedules missed meanwhile run once.
    for (const run of unfinishedRuns(this.store)) if (run.threadId) this.#armBudget(run.threadId);
    this.#automations.start();
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
    // Only a model asked for is the thread's own: TENZO_DEFAULT_MODEL and the project's config
    // are looked up as each session starts, so a change to either applies to running threads.
    const run = input.run;
    // An automation's run takes its model and thinking as the thread's own choice.
    const own = run ? runThreadOptions(run.automation) : input.model ? { model: input.model } : {};
    let baseNote = null as string | null; // set by createThread's callback
    const thread = await createThread(this.store, input.project, title, {
      ...own,
      ...(prompt && !given ? { naming: prompt } : {}),
      ...(client ? { client } : {}),
      ...(input.parent ? { parent: input.parent } : {}),
      ...(run ? { automation: run.name } : {}),
      onBaseNote: (note) => (baseNote = note),
    });
    // Where it started, when that needs saying (a default branch diverged from origin's).
    if (baseNote) this.#append(draft(thread, { type: "thread.noted", payload: { message: baseNote } }));
    // The run is on record before its session starts, so the session starts with its budget.
    transaction(this.store, () => {
      if (run) {
        insertRun(this.store, {
          projectId: run.project.id,
          name: run.name,
          trigger: run.trigger,
          result: "started",
          reason: null,
          threadId: thread.id,
          at: thread.createdAt,
          budget: run.budget,
        });
      }
      if (prompt) enqueuePrompt(this.store, thread.id, prompt);
    });
    this.#pump(thread.id);
    if (run) this.#armBudget(thread.id);
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
    // Archiving would drop it unread: say so now rather than lose it.
    if (this.#landing.has(thread.id) || this.#live.get(thread.id)?.landed) {
      throw new TenzoError(
        `${thread.id} has landed and is being archived; start a new thread for more work.`,
      );
    }
    if (this.#archiving.has(thread.id)) {
      throw new TenzoError(`${thread.id} is being archived; start a new thread for more work.`);
    }
    enqueuePrompt(this.store, thread.id, text);
    this.#pump(thread.id);
    return this.#changed(thread.id);
  }

  /**
   * Sets the thread's own model and thinking level, over its project's config, for every phase
   * from now on (null: the config decides again; `thinking` left out: it stays as it is). A
   * running session switches at once where the agent can, else at its next turn (`#pump`).
   */
  setModel(
    threadId: string,
    choice: { model: string | null; thinking?: ThinkingLevel | null | undefined },
  ): ThreadView {
    const thread = this.#active(threadId);
    let model: string | null = null;
    if (choice.model !== null) {
      const parsed = ModelName.safeParse(choice.model);
      if (!parsed.success) {
        throw new TenzoError(`"${choice.model.slice(0, 100)}" isn't a model name: ${parsed.error.issues[0]?.message ?? "invalid"}.`);
      }
      model = parsed.data;
    }
    const thinking = choice.thinking === undefined ? thread.thinking : choice.thinking;
    setThreadModel(this.store, thread.id, { model, thinking });
    const live = this.#live.get(thread.id);
    // What can't switch live waits for the turn boundary, where #pump starts it again.
    if (live && !live.restarting) live.session.reconfigure(this.#settingsOf(getThread(this.store, thread.id)));
    return this.#changed(thread.id);
  }

  /**
   * Stops the thread's agent, removes its worktree, and takes its items off the queue.
   * `unless`: why not to after all (a run that is no longer finished), asked once the checks'
   * waits are over and in the same tick as archiving starts, so nothing can come in between; a
   * reason refuses with `ArchiveHeld`. From then on, nothing new is sent to the thread (`send`).
   */
  async archive(
    threadId: string,
    options: { force?: boolean; unless?: () => string | null } = {},
  ): Promise<ThreadView> {
    const thread = getThread(this.store, threadId);
    if (thread.status === "archived") return this.view(thread.id);
    // Refuse before stopping anything: a refused archive must not kill the running turn.
    await checkArchivable(this.store, thread, options);
    if (getThread(this.store, thread.id).status === "archived") return this.view(thread.id);
    const held = options.unless?.() ?? null;
    if (held !== null) throw new ArchiveHeld(held);
    this.#archiving.add(thread.id); // no new session (nor prompt) while its worktree goes away
    let cutShort = false;
    try {
      const live = this.#live.get(thread.id);
      if (live) {
        cutShort = this.#cutShort(thread.id);
        await live.session.stop();
        await live.reading;
      }
      await archiveThread(this.store, thread.id, options);
      this.#archiving.delete(thread.id);
    } catch (error) {
      // Not archived (uncommitted work, say): the thread carries on with what it has queued,
      // and a turn the stop cut short picks up again.
      this.#archiving.delete(thread.id);
      if (cutShort) this.#resumeLater(thread.id);
      this.#pump(thread.id);
      throw error;
    }
    clearPrompts(this.store, thread.id);
    this.#wakes.clear(thread.id);
    this.#budgets.clear(thread.id);
    const run = runOfThread(this.store, thread.id);
    if (run) finishRun(this.store, run.id);
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

  /** Where threads' live apps are served, if anywhere. */
  get live(): LiveInfo | null {
    return this.#liveInfo;
  }

  /**
   * A thread's events after `after`; with `limit`, only the latest `limit` of those before
   * `before`, and whether there are earlier ones.
   */
  events(
    threadId: string,
    page: { after?: number; before?: number; limit?: number } = {},
  ): { thread: ThreadView; events: StoredEvent[]; older: boolean } {
    const thread = getThread(this.store, threadId);
    const view = this.#viewOf(thread);
    if (page.limit === undefined && page.before === undefined) {
      return { thread: view, events: threadEvents(this.store, thread.id, page.after ?? 0), older: false };
    }
    const limit = Math.min(page.limit ?? MAX_EVENT_PAGE, MAX_EVENT_PAGE);
    return { thread: view, ...eventPage(this.store, thread.id, { ...page, limit }) };
  }

  /**
   * The backlog for a client that starts watching a thread: the events after `after` when there
   * are at most `limit` of them (the client has the ones before), else the `limit` latest, which
   * replace what the client had. Synchronous on purpose: a caller that subscribes in the same
   * tick misses no event and sees none twice (socket.ts).
   */
  backlog(
    threadId: string,
    { after, limit = WATCH_BACKLOG }: { after?: number; limit?: number } = {},
  ): { thread: ThreadView; events: StoredEvent[]; older: boolean; reset: boolean } {
    const thread = getThread(this.store, threadId);
    const view = this.#viewOf(thread);
    const size = Math.min(limit, MAX_EVENT_PAGE);
    if (after !== undefined && countEventsAfter(this.store, thread.id, after) <= size) {
      return {
        thread: view,
        events: threadEvents(this.store, thread.id, after),
        older: false,
        reset: false,
      };
    }
    return { thread: view, ...eventPage(this.store, thread.id, { limit: size }), reset: true };
  }

  /** What the thread changed against its project's default branch, counted now (diff.ts). */
  async diff(threadId: string): Promise<ThreadDiff> {
    const thread = getThread(this.store, threadId);
    const project = projectOf(this.store, thread);
    const base = await resolveBase(project.path, project.defaultBranch);
    const options = { baseName: project.defaultBranch };
    // An archived thread's worktree is gone; its branch is kept, so compare that.
    if (thread.status === "active" && existsSync(thread.worktreePath)) {
      return diffStat(thread.worktreePath, base, options);
    }
    if (!(await branchExists(project.path, thread.branch))) {
      throw new TenzoError(
        `${thread.branch} is gone (deleted since the thread was archived), so there is no change to show.`,
      );
    }
    return diffStat(project.path, base, { ...options, head: `refs/heads/${thread.branch}` });
  }

  snapshot(): Snapshot {
    return {
      environmentId: this.store.environmentId,
      threads: this.threads(),
      items: openItems(this.store).filter((i) => !this.#quiet.has(i.id)),
      projects: this.projects(),
      live: this.#liveInfo,
      automations: this.automations(),
      automationsPaused: this.automationsPaused,
      automationProblems: this.automationProblems(),
    };
  }

  /** The projects whose config can't be read, so their automations don't run. */
  automationProblems(project?: string) {
    try {
      return this.#automations.problems(project);
    } catch (error) {
      if (project !== undefined) throw error;
      this.#log(`couldn't read the projects' configs: ${String(error)}`);
      return [];
    }
  }

  /**
   * Archives the automation's finished runs (their branches are kept): those with nothing
   * running or queued and nothing open but finished work, whose worktree is clean. A run that is
   * going, waits on you (a question, an error, its budget card) or has uncommitted changes stays.
   */
  async archiveFinishedRuns(
    projectRef: string,
    name: string,
  ): Promise<{ archived: ThreadView[]; kept: { threadId: ThreadId; reason: string }[] }> {
    const project = findProject(this.store, projectRef);
    const runs = activeRunsOf(this.store, project.id, name);
    if (runs.length === 0 && !automationsOf(this.#readConfig(project.path))[name]) {
      throw new TenzoError(`No automation "${name.slice(0, 100)}" in ${project.name}.`);
    }
    const archived: ThreadView[] = [];
    const kept: { threadId: ThreadId; reason: string }[] = [];
    for (const threadId of runs) {
      if (this.#runState(threadId) !== "finished") continue;
      const thread = getThread(this.store, threadId);
      if (existsSync(thread.worktreePath) && (await hasChanges(thread.worktreePath))) {
        this.#dirty.add(threadId);
        kept.push({ threadId, reason: "Its worktree has uncommitted changes." });
        continue;
      }
      try {
        // Looked at again once archive's own checks are done, in the tick it starts: a message
        // sent meanwhile makes the run go again, and it stays.
        archived.push(await this.archive(threadId, { unless: () => this.#unfinished(threadId) }));
      } catch (error) {
        if (error instanceof ArchiveHeld) continue;
        // One run that won't archive (a gone repo, git failing) doesn't stop the others.
        if (!(error instanceof TenzoError)) this.#log(`couldn't archive ${threadId}: ${String(error)}`);
        kept.push({ threadId, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    if (archived.length > 0) {
      this.#log(`automation ${project.name}/${name}: archived ${archived.length} finished run(s)`);
    }
    this.#automationsChanged();
    return { archived, kept };
  }

  /** The automations the projects' configs define, with their next and last runs. */
  automations(project?: string): AutomationView[] {
    try {
      return this.#automations.list(project);
    } catch (error) {
      if (project !== undefined) throw error;
      this.#log(`couldn't list the automations: ${String(error)}`);
      return [];
    }
  }

  /** Runs an automation now, by hand (Run now): an ordinary thread, origin `automation`. */
  runAutomation(project: string, name: string) {
    return this.#automations.run(project, name);
  }

  /** The automations' off switch: whether it is on, and turning it on or off. */
  get automationsPaused(): boolean {
    return this.#automations.paused;
  }

  pauseAutomations(paused: boolean): boolean {
    return this.#automations.setPaused(paused);
  }

  /** The automations as a list draws them: each one, the off switch, broken configs. */
  automationsState(): AutomationsState {
    return {
      automations: this.automations(),
      paused: this.automationsPaused,
      problems: this.automationProblems(),
    };
  }

  /**
   * Something the automations list shows may have changed: a run started or skipped, a run's
   * thread moved on, a schedule was worked out, the off switch flipped. Subscribers hear the
   * whole list once this tick's changes are in, and only when it differs from the last they heard.
   */
  #automationsChanged(): void {
    if (this.#closing || this.#automationsTimer) return;
    this.#automationsTimer = setTimeout(async () => {
      this.#automationsTimer = undefined;
      if (this.#closing) return;
      const look = ++this.#automationsLook;
      try {
        await this.#lookAtWorktrees();
        if (this.#closing || look !== this.#automationsLook) return; // a newer look sends
        const automations = this.automationsState();
        const json = JSON.stringify(automations);
        if (json === this.#automationsSent) return;
        this.#automationsSent = json;
        this.#emit({ type: "automations", automations });
      } catch (error) {
        this.#log(`couldn't look at the automations: ${String(error)}`);
      }
    }, 0);
  }

  /** Which finished runs have uncommitted changes (`#dirty`), so they aren't offered to archive. */
  async #lookAtWorktrees(): Promise<void> {
    const finished = activeRunThreads(this.store).filter((id) => this.#runState(id) === "finished");
    const dirty = await Promise.all(
      finished.map(async (id) => {
        const path = getThread(this.store, id).worktreePath;
        return existsSync(path) && (await hasChanges(path).catch(() => false)) ? id : null;
      }),
    );
    this.#dirty.clear();
    for (const id of dirty) if (id) this.#dirty.add(id);
  }

  /** Looks at the automations' schedules now (tests; the daemon does it on its own). */
  tickAutomations(): Promise<void> {
    return this.#automations.tick();
  }

  /**
   * Answers an item. If the agent is still waiting, the answer goes straight to it. If the
   * process that asked has ended (a crash, a daemon restart), the item is resolved here and the
   * answer is queued as a message to the resumed session (answers.ts), which then carries on.
   */
  async answer(
    itemId: string,
    answer: ItemAnswer,
  ): Promise<{
    item: QueueItem;
    delivery: "live" | "message" | "none" | "archived";
    thread: ThreadView;
  }> {
    const item = this.#openItem(itemId);
    if (this.#answering.has(item.id)) throw new TenzoError(`${item.id} is being answered already.`);
    const thread = this.#active(item.threadId);
    const checked = checkAnswer(item, answer);
    if (checked.kind === "error") return this.#answerError(item, thread, checked);
    if (checked.kind === "finished" || checked.kind === "ready") {
      return this.#answerAsMessage(item, thread, checked);
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

  /**
   * Swipes an item away for a while (`snoozeMs`, 15 minutes): it leaves the Pass on every device
   * and comes back by itself when its time comes, even across a restart. Snoozing it again
   * starts the time again.
   */
  snooze(itemId: string): { item: QueueItem; thread: ThreadView } {
    const item = this.#openItem(itemId);
    const thread = this.#active(item.threadId);
    const until = new Date(Date.now() + this.#snoozeMs).toISOString();
    this.#append(
      draft(thread, { type: "item.snoozed", requestId: item.requestId, payload: { until } }),
    );
    const snoozed = getItem(this.store, item.id) ?? item;
    this.#armSnooze(snoozed);
    return { item: snoozed, thread: this.view(thread.id) };
  }

  /** Brings a snoozed item back now (Undo). One that is awake already is left as it is. */
  unsnooze(itemId: string): { item: QueueItem; thread: ThreadView } {
    const item = this.#openItem(itemId);
    const thread = this.#active(item.threadId);
    this.#snoozes.clear(item.id);
    if (item.snoozedUntil !== null) {
      this.#append(
        draft(thread, {
          type: "item.unsnoozed",
          requestId: item.requestId,
          payload: { reason: "undo" },
        }),
      );
    }
    return { item: getItem(this.store, item.id) ?? item, thread: this.view(thread.id) };
  }

  /** Stops every session, leaving open items for the next daemon. */
  async close(): Promise<void> {
    this.#closing = true;
    this.#snoozes.clearAll();
    this.#wakes.clearAll();
    this.#budgets.clearAll();
    clearTimeout(this.#automationsTimer);
    this.#automationsTimer = undefined;
    this.#stopNaming.abort();
    stopDetachedGit(); // a `landed` check still fetching
    await this.#automations.close();
    await Promise.all([
      ...[...this.#live.values()].map(async (live) => {
        // Tenzo's own restart is no error of the agent's: the turn picks up when it is back.
        // Only a turn the stop really cut short: one that finishes within the stop's grace
        // needs no resuming.
        const cutShort = this.#cutShort(live.threadId);
        const before = lastEvent(this.store, live.threadId)?.seq ?? 0;
        await live.session.stop();
        await live.reading;
        const finished = threadEvents(this.store, live.threadId, before).some(
          (e) => e.event.type === "turn.completed",
        );
        if (cutShort && !finished) this.#resumeLater(live.threadId);
      }),
      ...this.#naming,
    ]);
  }

  // Internals.

  /**
   * Stopping the thread's session now would cut a turn short that isn't waiting on you. Only an
   * ask of the live session counts as waiting: finished work, a ready PR, an earlier error card
   * or an ask from a session that has ended is no reason not to resume.
   */
  #cutShort(threadId: ThreadId): boolean {
    const { runtime, open } = loadFoldState(this.store, threadId);
    // A prompt we sent counts even before its turn.started has come back.
    const sent = Boolean(this.#live.get(threadId)?.turnId);
    return (runtime.turnId !== null || sent) && !waitsOnYou(open);
  }

  /** The thread's next session starts by picking up the turn a stop of ours cut short. */
  #resumeLater(threadId: ThreadId): void {
    enqueuePrompt(this.store, threadId, RESTART_PROMPT, null, { first: true });
  }

  #openItem(itemId: string): QueueItem {
    const item = getItem(this.store, itemId);
    if (!item) throw new TenzoError(`No item "${itemId}". \`tenzo items\` lists the open ones.`);
    if (item.status !== "open") {
      throw new TenzoError(`${item.id} is no longer open (${item.resolution?.kind ?? "resolved"}).`);
    }
    return item;
  }

  /**
   * An error item's answer. Retry and Tell it something resolve it and queue the prompts (what
   * failed, or your words) as the thread's next turn, which resumes the agent if it has stopped.
   * Archive archives the thread, which dismisses the item; a refusal (uncommitted work) leaves
   * both as they were.
   */
  async #answerError(
    item: QueueItem,
    thread: Thread,
    answer: Extract<ItemAnswer, { kind: "error" }>,
  ): Promise<{ item: QueueItem; delivery: "message" | "none" | "archived"; thread: ThreadView }> {
    if (answer.action === "archive") {
      const archived = await this.archive(thread.id);
      return { item: getItem(this.store, item.id) ?? item, delivery: "archived", thread: archived };
    }
    if (item.error?.cause === "config") return this.#answerConfig(item, thread, answer.action);
    const resolution = draft(thread, {
      ...(item.turnId ? { turnId: item.turnId } : {}),
      ...resolutionOf(item, answer),
    } as Draft);
    // Continue on a budget card (Retry, or words): the run gets as much budget again.
    const run = item.error?.cause === "budget" ? runOfThread(this.store, thread.id) : undefined;
    const appended = transaction(this.store, () => {
      const result = appendEvent(this.store, resolution);
      if (run) grantMore(this.store, run);
      for (const prompt of errorPrompts(item, answer)) enqueuePrompt(this.store, thread.id, prompt);
      return result;
    });
    this.#publish(resolution, appended);
    if (run) this.#armBudget(thread.id);
    this.#pump(thread.id);
    return {
      item: getItem(this.store, item.id) ?? item,
      delivery: "message",
      thread: this.#changed(thread.id),
    };
  }

  /**
   * A config card's answer. Retry reads the project's config again: still wrong, a new card says
   * what is wrong now; fixed, a running session takes its settings. Dismiss puts it away until
   * what is wrong changes. Nothing goes to the agent either way.
   */
  #answerConfig(
    item: QueueItem,
    thread: Thread,
    action: Extract<ItemAnswer, { kind: "error" }>["action"],
  ): { item: QueueItem; delivery: "none"; thread: ThreadView } {
    this.#append(
      draft(thread, {
        ...(item.turnId ? { turnId: item.turnId } : {}),
        type: "error.resolved",
        requestId: item.requestId,
        payload: { action: action === "dismiss" ? "dismiss" : "retry" },
      }),
    );
    if (action !== "dismiss") {
      const settings = this.#settingsOf(thread);
      const live = this.#live.get(thread.id);
      if (live && !live.restarting) live.session.reconfigure(settings);
    }
    return {
      item: getItem(this.store, item.id) ?? item,
      delivery: "none",
      thread: this.#changed(thread.id),
    };
  }

  /**
   * Reads the thread's project config and keeps the project's one config card in step with it:
   * a card when it is invalid (its threads run on the defaults meanwhile), unless an open one
   * says so already or you dismissed this very problem; the card goes once the config is fine.
   * One card per project, on whichever thread found the problem first. Never throws: a config
   * can't stop a thread.
   */
  #checkConfig(thread: Thread): ConfigRead {
    const project = projectOf(this.store, thread);
    let read: ConfigRead;
    try {
      read = this.#configs.read(project.path);
    } catch (error) {
      read = { config: null, problem: `Couldn't read the project's config: ${String(error)}` };
    }
    try {
      const { open, last } = configCards(this.store, project.id);
      const problem = read.problem;
      const record = (owner: ThreadId, problem: string | null) =>
        this.#append(draft(getThread(this.store, owner), { type: "config.checked", payload: { problem } }));
      if (problem === null) {
        for (const card of open) record(card.threadId, null);
      } else {
        const message = errorMessage(problem);
        const shown = open.some((card) => card.error?.message === message);
        const dismissed =
          open.length === 0 &&
          last?.resolution?.kind === "acknowledged" &&
          last.error?.message === message;
        if (!shown && !dismissed) record(open[0]?.threadId ?? thread.id, problem);
      }
    } catch (error) {
      this.#log(`couldn't record ${project.name}'s config check: ${String(error)}`);
    }
    return read;
  }

  /**
   * What the thread's sessions run with, its project's config read now (`#checkConfig`), and,
   * for an automation's run with a cost budget, what it may spend (the agent stops its own turn
   * there, `budget.exceeded`).
   */
  #settingsOf(thread: Thread): SessionSettings {
    const read = this.#checkConfig(thread);
    const permissionMode = permissionsOf(read);
    const budget = this.#budgetOf(thread);
    return {
      models: this.#modelsOf(thread, read),
      ...(permissionMode ? { permissionMode } : {}),
      ...(budget?.capUsd !== undefined
        ? { budget: { capUsd: budget.capUsd, spentUsd: budget.run.costUsd ?? 0 } }
        : {}),
    };
  }

  /** A project's config, for the automations' scheduler: never throws. */
  #readConfig(root: string): ConfigRead {
    try {
      return this.#configs.read(root);
    } catch (error) {
      return { config: null, problem: `Couldn't read the project's config: ${String(error)}` };
    }
  }

  // Automation runs' budgets (PRODUCT.md §7): a run that reaches its budget is paused and asks.

  /**
   * The budget of the automation run `thread` is, while it applies (the run hasn't finished):
   * its spend cap and wall-clock deadline as granted so far (at start, and one more grant from
   * each Continue), and why it is over, if it is.
   */
  #budgetOf(thread: Thread): {
    run: AutomationRun;
    budget: RunBudget;
    capUsd?: number;
    deadline?: number;
    over: string | null;
  } | null {
    if (thread.origin !== "automation") return null;
    const run = runOfThread(this.store, thread.id);
    if (!run?.budget || run.finishedAt !== null) return null;
    const budget = run.budget;
    const capUsd = run.capUsd ?? undefined;
    const deadline = run.deadline ?? undefined;
    let over: string | null = null;
    if (deadline !== undefined && Date.now() >= deadline) {
      over = `its ${formatDuration(budget.wallClockMs)} of wall clock ran out (it started ${formatDuration(Date.now() - Date.parse(run.at))} ago)`;
    } else if (capUsd !== undefined && (run.costUsd ?? 0) >= capUsd) {
      over = `it has spent $${(run.costUsd ?? 0).toFixed(2)}, and its cap is $${capUsd.toFixed(2)}`;
    }
    return {
      run,
      budget,
      ...(capUsd !== undefined ? { capUsd } : {}),
      ...(deadline !== undefined ? { deadline } : {}),
      over,
    };
  }

  /** The thread's open budget card, if it has one: the run is paused. */
  #budgetCard(threadId: ThreadId): QueueItem | undefined {
    return openItems(this.store, threadId).find(
      (item) => item.kind === "error" && item.error?.cause === "budget",
    );
  }

  /**
   * Whether the next turn waits: the thread is an automation run over its budget, or paused by
   * it (a card asks). Over and not yet asked: the card goes up now.
   */
  #heldByBudget(thread: Thread): boolean {
    const budget = this.#budgetOf(thread);
    if (!budget) return false;
    if (this.#budgetCard(thread.id)) return true;
    if (budget.over === null) return false;
    this.#pauseRun(thread, budget.over);
    return true;
  }

  /** Puts the run's budget card on the Pass (once): Continue gives it as much again; Stop archives. */
  #pauseRun(thread: Thread, why: string): void {
    if (this.#budgetCard(thread.id)) return;
    const name = thread.automation ?? "an automation";
    try {
      this.#append(
        draft(thread, {
          type: "budget.exceeded",
          payload: {
            message: `This run of "${name}" reached its budget: ${why}. It's paused. Continue gives it as much again; Stop archives the thread.`,
            prompts: [
              `Tenzo paused you: this run of the automation "${name}" reached its budget (${why}). I've given it as much again. Carry on where you stopped: check what's already done first.`,
            ],
          },
        }),
      );
      this.#changed(thread.id);
    } catch (error) {
      this.#log(`couldn't pause ${thread.id} for its budget: ${String(error)}`);
    }
  }

  /** Sets the run's wall-clock timer, for its deadline as granted so far. */
  #armBudget(threadId: ThreadId): void {
    if (this.#closing) return;
    let deadline: number | undefined;
    try {
      deadline = this.#budgetOf(getThread(this.store, threadId))?.deadline;
    } catch {
      deadline = undefined;
    }
    if (deadline === undefined) return this.#budgets.clear(threadId);
    this.#budgets.set(threadId, deadline, (id) => this.#checkBudget(id));
  }

  /**
   * The run's deadline came. A turn running then is interrupted and the card goes up; one that
   * waits on your answer is left to it and looked at again in a minute; a run with no turn
   * running waits at its next turn (`#heldByBudget`).
   */
  #checkBudget(threadId: ThreadId): void {
    if (this.#closing) return;
    try {
      const thread = getThread(this.store, threadId);
      if (thread.status !== "active") return;
      const budget = this.#budgetOf(thread);
      if (!budget) return;
      if (budget.over === null) return this.#armBudget(threadId); // granted more, or early
      const live = this.#live.get(threadId);
      const { runtime, open } = loadFoldState(this.store, threadId);
      if (!live || (live.turnId === null && runtime.turnId === null)) return;
      if (waitsOnYou(open)) {
        this.#budgets.set(threadId, Date.now() + 60_000, (id) => this.#checkBudget(id));
        return;
      }
      this.#pauseRun(thread, budget.over);
      void live.session.interrupt().catch((error: unknown) => {
        this.#log(`couldn't interrupt ${threadId} for its budget: ${String(error)}`);
      });
    } catch (error) {
      this.#log(`couldn't check ${threadId}'s budget: ${String(error)}`);
    }
  }

  /**
   * A turn of an automation run ended: what Claude says the session has spent is kept; a run
   * over its budget (or one the agent stopped at its spending limit) is paused.
   */
  #budgetTurnEnded(live: Live, event: Extract<RuntimeEvent, { type: "turn.completed" }>): void {
    const thread = getThread(this.store, live.threadId);
    if (thread.origin !== "automation") return;
    const run = runOfThread(this.store, thread.id);
    if (!run) return;
    if (event.payload.costUsd !== undefined) recordCost(this.store, run.id, event.payload.costUsd);
    const budget = this.#budgetOf(thread);
    if (!budget) return;
    if (budget.over !== null) this.#pauseRun(thread, budget.over);
    else if (event.payload.stoppedBy === "budget") {
      this.#pauseRun(thread, "Claude stopped at the spend it was allowed");
    }
  }

  /** An automation run whose agent is done (`#runState` finished) is finished: no more budget. */
  #finishRunIfDone(threadId: ThreadId): void {
    const run = runOfThread(this.store, threadId);
    if (!run || run.finishedAt !== null || this.#runState(threadId) !== "finished") return;
    finishRun(this.store, run.id);
    this.#budgets.clear(threadId);
  }

  /**
   * Where an automation run's thread is. Paused: its budget card is open. Waiting: on you (a
   * question, a permission, a proposal, an error card, a ready PR). Going: working, or landing.
   * Finished: nothing running or queued, and nothing open but finished work (its card waits for
   * you; the run is done).
   */
  #runState(threadId: ThreadId): NonNullable<AutomationRunView["state"]> {
    const thread = getThread(this.store, threadId);
    if (thread.status !== "active") return "archived";
    if (this.#budgetCard(threadId)) return "paused";
    const view = this.#viewOf(thread);
    const asks = openItems(this.store, threadId).filter((item) => item.kind !== "finished");
    if (asks.length > 0 && (!view.working || waitsOnYou(asks))) return "waiting";
    if (view.working || view.phase === "landing") return "going";
    return "finished";
  }

  /**
   * Archives a finished run's thread (its branch stays) when nothing would be lost: no open
   * item, a clean worktree, and no commits beyond its base. A run with work stays for you.
   */
  async #retireRun(threadId: ThreadId): Promise<boolean> {
    const thread = getThread(this.store, threadId);
    if (thread.status !== "active" || this.#runState(threadId) !== "finished") return false;
    if (openItems(this.store, threadId).length > 0) return false;
    if (!existsSync(thread.worktreePath) || (await hasChanges(thread.worktreePath))) return false;
    const project = projectOf(this.store, thread);
    const base = await resolveBase(project.path, project.defaultBranch);
    if ((await commitsAhead(project.path, base, `refs/heads/${thread.branch}`)) > 0) return false;
    try {
      await this.archive(threadId, {
        unless: () => this.#unfinished(threadId) ?? (openItems(this.store, threadId).length > 0 ? "It has an open item." : null),
      });
    } catch (error) {
      if (error instanceof ArchiveHeld) return false;
      throw error;
    }
    return true;
  }

  /** Why a run isn't finished any more (a message came, a card opened), or null while it is. */
  #unfinished(threadId: ThreadId): string | null {
    const state = this.#runState(threadId);
    return state === "finished" ? null : `It is ${state} again.`;
  }

  /** The models: the thread's own choice, then its project's config, then the default. */
  #modelsOf(thread: Thread, read: ConfigRead) {
    return resolveModels({ thread, config: read.config, defaultModel: this.#defaultModel });
  }

  /** Brings the item back when its snooze is up (now, if it is already). */
  #armSnooze(item: QueueItem): void {
    if (item.snoozedUntil === null || this.#closing) return this.#snoozes.clear(item.id);
    this.#snoozes.set(item.id, Date.parse(item.snoozedUntil), (id) => this.#endSnooze(id));
  }

  #endSnooze(itemId: QueueItemId): void {
    if (this.#closing) return;
    try {
      const item = getItem(this.store, itemId);
      if (item?.status !== "open" || item.snoozedUntil === null) return;
      if (Date.parse(item.snoozedUntil) > Date.now()) {
        this.#armSnooze(item); // snoozed again meanwhile, or a timer cut short
        return;
      }
      const thread = getThread(this.store, item.threadId);
      if (thread.status !== "active") return;
      this.#append(
        draft(thread, {
          type: "item.unsnoozed",
          requestId: item.requestId,
          payload: { reason: "returned" },
        }),
      );
    } catch (error) {
      this.#log(`couldn't bring back ${itemId}: ${String(error)}`);
    }
  }

  /**
   * Your answer to finished work or a ready PR. Nothing waits on either, so it is recorded here
   * and, unless it is Done, sent to the agent as its next turn (prompts.ts), the session resumed
   * if it has stopped. Merge and Open PR make the thread landing, Needs changes building.
   */
  #answerAsMessage(
    item: QueueItem,
    thread: Thread,
    answer: Extract<ItemAnswer, { kind: "finished" | "ready" }>,
  ): { item: QueueItem; delivery: "message" | "none"; thread: ThreadView } {
    const note = answer.note ? { note: answer.note } : {};
    const turn = item.turnId ? { turnId: item.turnId } : {};
    const resolution =
      answer.kind === "finished"
        ? draft(thread, {
            ...turn,
            type: "report.resolved",
            requestId: item.requestId,
            payload: { decision: answer.decision, ...note },
          })
        : draft(thread, {
            ...turn,
            type: "merge.resolved",
            requestId: item.requestId,
            payload: { decision: answer.decision, ...note },
          });
    const prompt =
      answer.kind === "finished" ? reviewPrompt(answer, this.#prompts()) : mergePrompt(answer);
    // Both or neither, as with any answer delivered as a message.
    const appended = transaction(this.store, () => {
      const result = appendEvent(this.store, resolution);
      if (prompt) enqueuePrompt(this.store, thread.id, prompt);
      return result;
    });
    this.#publish(resolution, appended);
    if (prompt) this.#pump(thread.id);
    return {
      item: getItem(this.store, item.id) ?? item,
      delivery: prompt ? "message" : "none",
      thread: this.#changed(thread.id),
    };
  }

  /** Sets the thread's wake timer from its log (`wake_me`); a time already past rings now. */
  #armWake(threadId: ThreadId): void {
    const wake = this.#closing ? null : loadFoldState(this.store, threadId).runtime.wake;
    if (!wake) return this.#wakes.clear(threadId);
    this.#wakes.set(threadId, Date.parse(wake.at), (id) => this.#ringWake(id));
  }

  /** The wake's time has come: "You asked to be woken: <why>" goes to the agent as a turn. */
  #ringWake(threadId: ThreadId): void {
    if (this.#closing) return;
    try {
      const thread = getThread(this.store, threadId);
      if (thread.status !== "active") return;
      const wake = loadFoldState(this.store, threadId).runtime.wake;
      if (!wake) return;
      if (Date.parse(wake.at) > Date.now()) {
        this.#armWake(threadId); // a later wake replaced it, or a long one checks again
        return;
      }
      const fired = draft(thread, { type: "wake.fired", payload: { why: wake.why } });
      const appended = transaction(this.store, () => {
        const result = appendEvent(this.store, fired);
        enqueuePrompt(this.store, thread.id, wakePrompt(wake.why));
        return result;
      });
      this.#publish(fired, appended);
      this.#pump(thread.id);
      this.#changed(thread.id);
    } catch (error) {
      this.#log(`couldn't wake ${threadId}: ${String(error)}`);
    }
  }

  /**
   * Archives a thread whose agent said it landed (and git agreed): worktree removed, branch
   * kept. If that can't be done, or you sent it a message meanwhile (archiving would drop it
   * unread), the thread stays, landing, with an error card that says why.
   */
  #archiveLanded(threadId: ThreadId): void {
    if (this.#closing || this.#landing.has(threadId)) return;
    const waiting = queuedPrompts(this.store, threadId).filter((p) => p !== RESTART_PROMPT);
    if (waiting.length > 0) {
      clearPrompts(this.store, threadId);
      this.#landingStuck(
        threadId,
        "unarchived",
        `It landed, but you sent it a message meanwhile, so it isn't archived. Retry sends your message; Archive drops it. ${STILL_LANDED}`,
        waiting,
      );
      return;
    }
    this.#landing.add(threadId);
    void this.archive(threadId)
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.#log(`couldn't archive ${threadId}, which landed: ${message}`);
        this.#landingStuck(threadId, "unarchived", `It landed, but Tenzo couldn't archive it: ${sentence(message)} ${STILL_LANDED}`, [
          `Tenzo couldn't archive this thread after \`landed\`: ${message}\n\nLeave the worktree clean (commit or delete stray files), then call \`landed\` again.`,
        ]);
      })
      .finally(() => {
        this.#landing.delete(threadId);
        this.#pump(threadId); // not archived: what came in meanwhile goes after all
      });
  }

  /**
   * A landing turn of ours ended with nothing to come: no wake, no card, no `landed`, nothing
   * queued. The thread would sit in Landing forever, so it gets an error card instead. A turn
   * already running (`#pump` just sent what was queued) is something to come.
   */
  #checkStalled(live: Live): void {
    if (this.#closing || live.landed || live.turnId) return;
    const { runtime, open } = loadFoldState(this.store, live.threadId);
    if (runtime.phase !== "landing" || runtime.wake !== null || open.length > 0) return;
    if (queuedCount(this.store, live.threadId) > 0) return;
    this.#landingStuck(
      live.threadId,
      "stalled",
      "Its last turn ended without a wake, a card or `landed`, so nothing happens next. Retry reminds it how to land; or tell it what to do.",
      [STALLED_PROMPT],
    );
  }

  /** Puts a landing error card on the Pass (`landing.stuck`); Retry sends `prompts`. */
  #landingStuck(
    threadId: ThreadId,
    cause: "stalled" | "unarchived",
    message: string,
    prompts: string[],
  ): void {
    try {
      this.#append(
        draft(getThread(this.store, threadId), {
          type: "landing.stuck",
          payload: { cause, message, prompts },
        }),
      );
      this.#changed(threadId);
    } catch (error) {
      this.#log(`couldn't record that ${threadId} is stuck landing: ${String(error)}`);
    }
  }

  /** What `landed` must pass: a clean worktree whose branch's changes are on origin's default branch. */
  async #checkLanded(threadId: ThreadId): Promise<void> {
    const thread = getThread(this.store, threadId);
    if (await hasChanges(thread.worktreePath)) {
      throw new TenzoError(
        "The worktree has uncommitted changes, and archiving removes it. Commit them or delete them, then call landed again.",
      );
    }
    const branch = projectOf(this.store, thread).defaultBranch;
    if (!(await landedOn(thread.worktreePath, branch))) {
      throw new TenzoError(
        `Can't see this branch's changes in origin/${branch}, so it hasn't landed. Merge the PR with \`gh pr merge\` first; if it did merge, ask the person (AskUserQuestion) to archive the thread.`,
      );
    }
  }

  /**
   * `start_thread` for `parentId`. No fan-out: a thread an agent started can't start threads,
   * each thread starts at most `MAX_CHILD_THREADS`, and at most `MAX_AGENT_THREADS` threads
   * started by agents are active at once.
   */
  async #startChild(
    parentId: ThreadId,
    input: { prompt: string; project?: string; title?: string },
  ): Promise<ThreadView> {
    const parent = getThread(this.store, parentId);
    if (parent.origin === "agent") {
      throw new TenzoError("This thread was started by another thread, so it can't start threads itself.");
    }
    const pending = this.#startingChildren.get(parentId) ?? 0;
    if (countChildren(this.store, parentId) + pending >= MAX_CHILD_THREADS) {
      throw new TenzoError(`A thread starts at most ${MAX_CHILD_THREADS} threads.`);
    }
    const starting = [...this.#startingChildren.values()].reduce((a, b) => a + b, 0);
    if (activeAgentThreads(this.store) + starting >= MAX_AGENT_THREADS) {
      throw new TenzoError(
        `${MAX_AGENT_THREADS} threads started by agents are active already: the person archives some first.`,
      );
    }
    this.#startingChildren.set(parentId, pending + 1);
    try {
      return await this.createThread({
        ...input,
        project: input.project ?? projectOf(this.store, parent).name,
        parent: parentId,
      });
    } finally {
      const left = (this.#startingChildren.get(parentId) ?? 1) - 1;
      if (left > 0) this.#startingChildren.set(parentId, left);
      else this.#startingChildren.delete(parentId);
    }
  }

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
    if (this.#closing || this.#archiving.has(threadId) || this.#landing.has(threadId)) return;
    const thread = getThread(this.store, threadId);
    if (thread.status !== "active") return;
    let live = this.#live.get(threadId);
    if (live?.turnId || live?.restarting || live?.switching) return;
    const prompt = nextPrompt(this.store, threadId);
    if (!prompt) return;
    // An automation run over its budget, or paused by it, sends nothing until you say Continue.
    if (this.#heldByBudget(thread)) return;

    // The thread's settings may have changed since its session started (its own model, its
    // project's config, Build it): the session takes them before the turn goes, or, when it
    // can't live, ends here at the turn boundary and the next one starts with them (#read pumps
    // again). Not while it has work running in the background, or a turn of Claude's own (a
    // background task reporting), which ending it would cut off: the turn goes to it as it is,
    // and the change waits for a turn boundary without, or for the session's natural end (the
    // next one starts with the settings of the day). After a switch that timed out, the turn
    // goes as things are (`asIs`).
    if (live?.asIs) {
      live.asIs = false;
    } else if (live) {
      const change = live.session.reconfigure(this.#settingsOf(thread));
      if (change === "restart" && this.#canRestart(live)) return this.#restartSession(live);
      if (change !== "unchanged" && change !== "restart") return this.#awaitSwitch(live, change);
    }

    if (!live) {
      const restarted = this.#restarted.delete(threadId);
      try {
        live = this.#startSession(thread, restarted);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const unsent = queuedPrompts(this.store, threadId);
        clearPrompts(this.store, threadId);
        // The error item it opens keeps the prompts, so Retry can send them again.
        this.#append(
          draft(thread, {
            type: "runtime.error",
            payload: {
              message: `Couldn't start ${thread.agent ?? "claude"}: ${message} (${unsent.length} prompt(s) not sent)`,
              unsent,
            },
          }),
        );
        this.#changed(threadId);
        return;
      }
      // Started again to change its settings: Claude may have restored the conversation's model
      // with it, so it takes the thread's settings before its first turn too. (Never a second
      // restart from here: a new session has nothing else to drop.)
      if (restarted) {
        const change = live.session.reconfigure(this.#settingsOf(thread));
        if (change !== "unchanged" && change !== "restart") return this.#awaitSwitch(live, change);
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

  /**
   * Whether ending the session now would cut nothing short: no background work (it would die
   * with the process) and no turn Claude started by itself (a background task reporting).
   */
  #canRestart(live: Live): boolean {
    return !live.session.backgroundWork && loadFoldState(this.store, live.threadId).runtime.turnId === null;
  }

  /**
   * The next turn waits for a switch under way, up to `switchTimeoutMs`. Claude not answering
   * by then, the session ends at this turn boundary instead (`#restartSession`), once: a
   * session that is itself such a restart, or one that can't end now (`#canRestart`), sends the
   * turn as things are, with a note, rather than restarting again and again.
   */
  #awaitSwitch(live: Live, change: Promise<void>): void {
    live.switching = true;
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), this.#switchTimeoutMs);
    });
    void Promise.race([change.then(() => "done" as const, () => "done" as const), late]).then((outcome) => {
      clearTimeout(timer);
      live.switching = false;
      if (this.#live.get(live.threadId) !== live) return;
      if (outcome === "late") {
        this.#log(`${live.threadId}'s agent didn't confirm a model switch in ${this.#switchTimeoutMs} ms`);
        this.#append(
          draft(getThread(this.store, live.threadId), {
            type: "runtime.error",
            payload: {
              message: live.restarted
                ? "Claude didn't confirm the switch of model or thinking in time; this turn runs on what it has."
                : "Claude didn't confirm the switch of model or thinking in time.",
            },
          }),
        );
        if (!live.restarted && this.#canRestart(live)) return this.#restartSession(live);
        live.asIs = true;
      }
      this.#pump(live.threadId);
    });
  }

  /**
   * Ends the thread's session at this turn boundary so the next one starts with its settings
   * (#read pumps once it has ended). One that won't end within `switchTimeoutMs` is let go of:
   * its queued prompts go on an error card, whose Retry starts a new session with them, so the
   * thread never sits stalled.
   */
  #restartSession(live: Live): void {
    live.restarting = true;
    this.#restarted.add(live.threadId);
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<string>((resolve) => {
      timer = setTimeout(() => resolve(`it didn't stop within ${this.#switchTimeoutMs} ms`), this.#switchTimeoutMs);
    });
    const stopped = live.session.stop().then(
      () => null,
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    void Promise.race([stopped, late]).then((failure) => {
      clearTimeout(timer);
      if (failure !== null) this.#abandon(live, failure);
    });
  }

  /** Lets go of a session that won't end, and puts what it was to do on an error card. */
  #abandon(live: Live, reason: string): void {
    if (this.#live.get(live.threadId) !== live) return;
    live.abandoned = true;
    this.#live.delete(live.threadId);
    this.#restarted.delete(live.threadId);
    this.#log(`let go of ${live.threadId}'s session: ${reason}`);
    try {
      const thread = getThread(this.store, live.threadId);
      const unsent = queuedPrompts(this.store, thread.id);
      clearPrompts(this.store, thread.id);
      this.#append(draft(thread, { type: "session.exited", payload: { exitKind: "error", reason } }));
      this.#append(
        draft(thread, {
          type: "runtime.error",
          payload: {
            message: `Tenzo couldn't restart the agent to change its settings: ${reason} (${unsent.length} prompt(s) not sent)`,
            unsent,
          },
        }),
      );
      this.#changed(thread.id);
    } catch (error) {
      this.#log(`couldn't record letting go of ${live.threadId}'s session: ${String(error)}`);
    }
  }

  #startSession(thread: Thread, restarted = false): Live {
    const agent = thread.agent ?? "claude";
    const adapter = this.#adapters[agent];
    if (!adapter) throw new TenzoError(`No ${agent} adapter.`);
    // Read as each session starts (and before each turn, #pump), so an edit applies at once.
    const { models, permissionMode, budget } = this.#settingsOf(thread);
    const session = adapter.start({
      threadId: thread.id,
      cwd: thread.worktreePath,
      ...(thread.sessionId ? { resumeSessionId: thread.sessionId } : {}),
      ...(restarted ? { restarted } : {}),
      models,
      ...(permissionMode ? { permissionMode } : {}),
      ...(budget ? { budget } : {}),
      ...(() => {
        const runtime = loadFoldState(this.store, thread.id).runtime;
        // The attach cap counts what this thread already holds for its next report.
        return { phase: runtime.phase, pendingAttachments: runtime.attachments.length };
      })(),
      prompts: this.#prompts(),
      attachmentsDir: attachmentsDir(this.store.home, thread.id),
      host: {
        phase: () => loadFoldState(this.store, thread.id).runtime.phase,
        checkLanded: () => this.#checkLanded(thread.id),
        startThread: async (input) => {
          const started = await this.#startChild(thread.id, input);
          return {
            id: started.id,
            title: started.title,
            projectName: started.projectName,
            branch: started.branch,
          };
        },
      },
    });
    const live: Live = {
      threadId: thread.id,
      session,
      turnId: null,
      standing: [],
      reading: Promise.resolve(),
      landed: false,
      restarting: false,
      switching: false,
      abandoned: false,
      restarted,
      asIs: false,
      clock: { spentUsd: 0, asking: new Set(), waitingSince: null, waitedMs: 0 },
    };
    this.#live.set(thread.id, live);
    live.reading = this.#read(live);
    return live;
  }

  async #read(live: Live): Promise<void> {
    try {
      for await (const event of live.session.events) {
        if (live.abandoned) continue;
        try {
          this.#ingest(live, event);
        } catch (error) {
          this.#log(`couldn't store a ${event.type} event of ${live.threadId}: ${String(error)}`);
        }
      }
    } finally {
      if (live.abandoned) return;
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
      // It landed and ended before its turn did: archive it all the same.
      if (live.landed) this.#archiveLanded(live.threadId);
      // Prompts that came in while it was ending start a new session.
      this.#pump(live.threadId);
    }
  }

  #ingest(live: Live, reported: RuntimeEvent): void {
    const event = measureTurn(live.clock, reported);
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
      case "turn.completed": {
        const ours = event.turnId === live.turnId;
        if (ours) {
          live.turnId = null;
          live.standing = [];
        }
        // An automation run: what it spent, and whether that pauses it (before anything goes).
        this.#budgetTurnEnded(live, event);
        // The turn that landed the thread is over: it archives instead of going on.
        if (live.landed) this.#archiveLanded(live.threadId);
        else if (ours) {
          this.#pump(live.threadId);
          if (event.payload.state === "completed") this.#checkStalled(live);
        }
        this.#finishRunIfDone(live.threadId);
        this.#changed(live.threadId);
        break;
      }
      case "thread.landed":
        live.landed = true;
        break;
      case "wake.scheduled":
        this.#armWake(live.threadId);
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
        this.#snoozes.clear(change.item.id);
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
    // A run's thread moving on is its automation's last run (or finished runs) changing.
    if (view.origin === "automation") this.#automationsChanged();
    return view;
  }

  #viewOf(thread: Thread): ThreadView {
    const runtime = loadFoldState(this.store, thread.id).runtime;
    const queued = queuedCount(this.store, thread.id);
    // An item being answered for you doesn't make the thread need you, not even for a moment;
    // nor does a snoozed one, until it wakes (`#wake` clears `snoozedUntil` when it does).
    const items = openItems(this.store, thread.id).filter((i) => !this.#quiet.has(i.id));
    const open = items.length;
    const awake = items.filter((i) => i.snoozedUntil === null).length;
    const live = this.#live.get(thread.id);
    const working =
      thread.status === "active" &&
      (queued > 0 || Boolean(live?.turnId) || (runtime.live && runtime.turnId !== null));
    const last = lastEvent(this.store, thread.id);
    const project = projectOf(this.store, thread);
    return {
      id: thread.id,
      environmentId: thread.environmentId,
      projectId: thread.projectId,
      projectName: project.name,
      title: thread.title,
      branch: thread.branch,
      worktreePath: thread.worktreePath,
      status: thread.status,
      agent: runtime.agent ?? thread.agent,
      model: thread.model,
      thinking: thread.thinking,
      landing: this.#landingOf(project.path),
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      archivedAt: thread.archivedAt,
      phase: runtime.phase,
      landed: hasLanded(this.store, thread.id),
      origin: thread.origin,
      parentId: thread.parentId,
      automation: thread.automation,
      wakeAt: thread.status === "active" ? (runtime.wake?.at ?? null) : null,
      activity: awake > 0 ? "needs-you" : open > 0 ? "snoozed" : working ? "working" : "idle",
      working,
      queued,
      openItems: open,
      lastSeq: last?.seq ?? 0,
      activeAt: last?.at ?? thread.createdAt,
    };
  }

  /** The project's landing rule; Merge when its config has none or can't be read. */
  #landingOf(root: string) {
    try {
      return landingOf(this.#configs.read(root));
    } catch {
      return "merge" as const;
    }
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

/** An archive called off by its `unless`: the thread is no longer what the caller looked at. */
export class ArchiveHeld extends TenzoError {
  override name = "ArchiveHeld";
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

/** An answer that goes to a waiting agent: everything but finished work's and a ready PR's. */
type AgentAnswer = Exclude<ItemAnswer, { kind: "finished" | "ready" }>;

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
    case "error":
      throw new Error("An error item has no agent waiting on it."); // #answerError's, never here
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
    case "error":
      return {
        type: "error.resolved",
        requestId,
        payload: {
          action: answer.action === "tell" ? "tell" : "retry",
          ...(answer.text ? { text: answer.text } : {}),
        },
      };
  }
}
