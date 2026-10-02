import {
  type AgentKind,
  type QueueItem,
  QueueItem as QueueItemSchema,
  RuntimeEvent,
  type StoredEvent,
  type ThreadId,
  type TurnId,
} from "@tenzo/contracts";
import type { StandingReply } from "./answers.ts";
import { type FoldState, foldEvent, type ItemChange, type ThreadRuntime } from "./fold.ts";
import { type Store, transaction } from "./store.ts";

/**
 * The event log and what is folded from it, in SQLite. Appending an event and storing its
 * effect on the thread and its items happen in one transaction, so the projection never drifts
 * from the log, and a restarted daemon reads it back as it was.
 */

export interface Appended {
  seq: number;
  runtime: ThreadRuntime;
  changes: ItemChange[];
}

/** Appends one event to the log and folds it into its thread and items. */
export function appendEvent(store: Store, event: RuntimeEvent): Appended {
  return transaction(store, () => {
    const state = loadFoldState(store, event.threadId);
    const { lastInsertRowid } = store.db
      .prepare(
        `INSERT INTO events
           (id, environment_id, thread_id, type, turn_id, request_id, created_at, body)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.eventId,
        store.environmentId,
        event.threadId,
        event.type,
        event.turnId ?? null,
        "requestId" in event ? event.requestId : null,
        event.createdAt,
        JSON.stringify(event),
      );
    const folded = foldEvent(state, event, store.environmentId);
    const r = folded.state.runtime;
    store.db
      .prepare(
        `UPDATE threads SET live = ?, agent = ?, session_id = ?, turn_id = ?, context = ?
         WHERE id = ?`,
      )
      .run(r.live ? 1 : 0, r.agent, r.sessionId, r.turnId, r.context, event.threadId);
    for (const change of folded.changes) saveItem(store, change.item);
    return { seq: Number(lastInsertRowid), runtime: r, changes: folded.changes };
  });
}

/** A thread's runtime and open items, as the last fold left them. */
export function loadFoldState(store: Store, threadId: ThreadId): FoldState {
  const row = store.db
    .prepare("SELECT live, agent, session_id, turn_id, context FROM threads WHERE id = ?")
    .get(threadId);
  if (!row) throw new Error(`No thread ${threadId} for an event`);
  return {
    runtime: {
      live: row.live === 1,
      agent: row.agent === null ? null : (String(row.agent) as AgentKind),
      sessionId: row.session_id === null ? null : String(row.session_id),
      turnId: row.turn_id === null ? null : (String(row.turn_id) as TurnId),
      context: String(row.context ?? ""),
    },
    open: queryItems(store, "WHERE thread_id = ? AND status = 'open'", threadId),
  };
}

export function saveItem(store: Store, item: QueueItem): void {
  store.db
    .prepare(
      `INSERT INTO items
         (id, environment_id, thread_id, request_id, kind, lane, status, created_at, resolved_at, body)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET
         status = excluded.status, resolved_at = excluded.resolved_at, body = excluded.body`,
    )
    .run(
      item.id,
      item.environmentId,
      item.threadId,
      item.requestId,
      item.kind,
      item.lane,
      item.status,
      item.createdAt,
      item.resolvedAt,
      JSON.stringify(item),
    );
}

export function getItem(store: Store, id: string): QueueItem | undefined {
  return queryItems(store, "WHERE id = ?", id)[0];
}

/** Open items of active threads, oldest first: the queue. */
export function openItems(store: Store, threadId?: ThreadId): QueueItem[] {
  return queryItems(
    store,
    `WHERE status = 'open'
       AND thread_id IN (SELECT id FROM threads WHERE status = 'active')
       AND (:thread IS NULL OR thread_id = :thread)`,
    { thread: threadId ?? null },
  );
}

/** Closes a thread's open items without an answer (its thread was archived). */
export function dismissItems(store: Store, threadId: ThreadId): ItemChange[] {
  return transaction(store, () => {
    const at = new Date().toISOString();
    return queryItems(store, "WHERE thread_id = ? AND status = 'open'", threadId).map((open) => {
      const item: QueueItem = {
        ...open,
        status: "resolved",
        resolvedAt: at,
        resolution: { kind: "dismissed" },
      };
      saveItem(store, item);
      return { type: "resolved", item };
    });
  });
}

function queryItems(
  store: Store,
  where: string,
  param: string | Record<string, string | null>,
): QueueItem[] {
  const statement = store.db.prepare(`SELECT body FROM items ${where} ORDER BY created_at, rowid`);
  return (typeof param === "string" ? statement.all(param) : statement.all(param))
    .map((row) => QueueItemSchema.parse(JSON.parse(String(row.body))));
}

/** A thread's events after `after`, oldest first. */
export function threadEvents(store: Store, threadId: ThreadId, after = 0): StoredEvent[] {
  return store.db
    .prepare(
      "SELECT seq, environment_id, body FROM events WHERE thread_id = ? AND seq > ? ORDER BY seq",
    )
    .all(threadId, after)
    .map((row) => ({
      seq: Number(row.seq),
      environmentId: String(row.environment_id) as StoredEvent["environmentId"],
      event: RuntimeEvent.parse(JSON.parse(String(row.body))),
    }));
}

export function lastSeq(store: Store, threadId: ThreadId): number {
  const row = store.db.prepare("SELECT MAX(seq) AS seq FROM events WHERE thread_id = ?").get(threadId);
  return Number(row?.seq ?? 0);
}

/** Threads whose agent session was running when the daemon last stopped. */
export function liveThreads(store: Store): ThreadId[] {
  return store.db
    .prepare("SELECT id FROM threads WHERE live = 1 ORDER BY created_at")
    .all()
    .map((row) => String(row.id) as ThreadId);
}

// The prompt queue: prompts wait here until their thread's running turn ends.

export interface QueuedPrompt {
  seq: number;
  threadId: ThreadId;
  text: string;
  /** For a turn that delivers an answer: what to answer if the agent asks the same again. */
  reply: StandingReply | null;
  createdAt: string;
}

export function enqueuePrompt(
  store: Store,
  threadId: ThreadId,
  text: string,
  reply: StandingReply | null = null,
): void {
  store.db
    .prepare(
      "INSERT INTO prompts (environment_id, thread_id, text, reply, created_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(
      store.environmentId,
      threadId,
      text,
      reply === null ? null : JSON.stringify(reply),
      new Date().toISOString(),
    );
}

export function nextPrompt(store: Store, threadId: ThreadId): QueuedPrompt | undefined {
  const row = store.db
    .prepare("SELECT * FROM prompts WHERE thread_id = ? ORDER BY seq LIMIT 1")
    .get(threadId);
  if (!row) return undefined;
  return {
    seq: Number(row.seq),
    threadId,
    text: String(row.text),
    reply: row.reply === null ? null : (JSON.parse(String(row.reply)) as StandingReply),
    createdAt: String(row.created_at),
  };
}

export function removePrompt(store: Store, seq: number): void {
  store.db.prepare("DELETE FROM prompts WHERE seq = ?").run(seq);
}

export function clearPrompts(store: Store, threadId: ThreadId): void {
  store.db.prepare("DELETE FROM prompts WHERE thread_id = ?").run(threadId);
}

export function queuedCount(store: Store, threadId: ThreadId): number {
  const row = store.db.prepare("SELECT COUNT(*) AS n FROM prompts WHERE thread_id = ?").get(threadId);
  return Number(row?.n ?? 0);
}

/** Active threads with prompts waiting, oldest first. */
export function threadsWithPrompts(store: Store): ThreadId[] {
  return store.db
    .prepare(
      `SELECT DISTINCT p.thread_id AS id FROM prompts p JOIN threads t ON t.id = p.thread_id
       WHERE t.status = 'active' ORDER BY p.thread_id`,
    )
    .all()
    .map((row) => String(row.id) as ThreadId);
}
