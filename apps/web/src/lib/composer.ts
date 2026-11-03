import { isSnoozed, type QueueItem, type StoredEvent, type ThreadView } from '@tenzo/client-runtime';

/**
 * The thread page's message field (the mock-up's replies/3): when it shows, what it says, and the
 * messages sent from it that are still waiting their turn, shown at the end of the timeline.
 */

/**
 * Whether the thread takes a message here: it is active, and nothing open for it but a reply
 * (whose answer this is too). Anything else open is answered on its card, on the Pass.
 */
export function takesMessages(thread: ThreadView | undefined, items: readonly QueueItem[]): boolean {
	if (!thread || thread.status !== 'active') return false;
	return !items.some((i) => i.threadId === thread.id && i.kind !== 'reply');
}

/** What the thread page shows at its foot: the field, the way to the Pass, or nothing. */
export function footOf(
	thread: ThreadView | undefined,
	items: readonly QueueItem[]
): 'field' | 'pass' | 'none' {
	if (!thread || thread.status !== 'active') return 'none';
	if (takesMessages(thread, items)) return 'field';
	// Something waits on you: on the Pass. Only snoozed ones: the field is no answer to them.
	return items.some((i) => i.threadId === thread.id && !isSnoozed(i)) ? 'pass' : 'none';
}

/**
 * The thread as the page shows it. Once archived it leaves the Pass's list, and the watch's copy
 * is from before: its log says it was archived (here, on the Pass or from the CLI).
 */
export function asShown(
	thread: ThreadView | undefined | null,
	events: readonly StoredEvent[]
): ThreadView | undefined {
	if (!thread) return undefined;
	if (thread.status === 'archived' || !events.some(({ event }) => event.type === 'thread.archived')) {
		return thread;
	}
	return { ...thread, status: 'archived', working: false, queued: 0 };
}

/** The field's hint: a message sent while it works waits for the turn to end. */
export function placeholderOf(thread: ThreadView | undefined): string {
	return thread?.working ? 'Message… (waits its turn)' : 'Message…';
}

/** A message sent from this page, not yet seen starting a turn. */
export interface Pending {
	/** As sent, trimmed: a turn that starts with exactly this prompt took it. */
	text: string;
	/** The thread's last event when it was sent: only a later turn can be it. */
	after: number;
}

/**
 * The messages still waiting: each one until a turn after it was sent starts with it (oldest
 * first, one turn each). Once nothing runs and nothing is queued, none waits any more (it ran,
 * or an archive dropped it).
 */
export function stillWaiting(
	pending: readonly Pending[],
	events: readonly StoredEvent[],
	thread: ThreadView | undefined
): Pending[] {
	if (pending.length === 0) return [];
	if (!thread || thread.status !== 'active' || (!thread.working && thread.queued === 0)) return [];
	const used = new Set<number>();
	return pending.filter((p) => {
		const taken = events.find(
			({ seq, event }) =>
				seq > p.after && !used.has(seq) && event.type === 'turn.started' && event.payload.prompt === p.text
		);
		if (!taken) return true;
		used.add(taken.seq);
		return false;
	});
}
