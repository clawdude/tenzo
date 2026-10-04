import { isSnoozed, type QueueItem, type ThreadView } from '@tenzo/client-runtime';

/**
 * The Threads list's logic: which group each thread is in and the one word that says how it is.
 * Kept out of the component so it can be tested.
 */

export type GroupKey = 'needs-you' | 'working' | 'landing' | 'today' | 'earlier';

/** The dot's colour: clay needs you, blue works, green is done, grey is quiet. */
export type Tone = 'clay' | 'working' | 'done' | 'quiet';

export interface Row {
	thread: ThreadView;
	tone: Tone;
	/** One word of status. */
	word: string;
}

export interface Group {
	key: GroupKey;
	label: string;
	rows: Row[];
}

const LABELS: Record<GroupKey, string> = {
	'needs-you': 'Needs you',
	working: 'Working',
	landing: 'Landing',
	today: 'Today',
	earlier: 'Earlier'
};
const ORDER: GroupKey[] = ['needs-you', 'working', 'landing', 'today', 'earlier'];

/**
 * The threads in their groups, in the list's order, empty groups left out. Needs you and Working
 * keep the threads' own order (oldest first); Today and Earlier show the latest active first.
 * Landing has no members until threads can land (M2); its place is kept.
 */
export function groupThreads(
	threads: readonly ThreadView[],
	items: readonly QueueItem[],
	now: number
): Group[] {
	const rows: Record<GroupKey, Row[]> = {
		'needs-you': [],
		working: [],
		landing: [],
		today: [],
		earlier: []
	};
	for (const thread of threads) {
		const row = rowOf(thread, items);
		rows[groupOf(thread, now, items)].push(row);
	}
	for (const key of ['today', 'earlier'] as const) {
		rows[key].sort((a, b) => Date.parse(b.thread.activeAt) - Date.parse(a.thread.activeAt));
	}
	return ORDER.filter((key) => rows[key].length > 0).map((key) => ({
		key,
		label: LABELS[key],
		rows: rows[key]
	}));
}

export function groupOf(
	thread: ThreadView,
	now: number,
	items: readonly QueueItem[] = []
): GroupKey {
	if (waitsOn(thread, items) === 'now') return 'needs-you';
	if (thread.activity === 'working') return 'working';
	return sameDay(Date.parse(thread.activeAt), now) ? 'today' : 'earlier';
}

/**
 * Whether the thread waits on you: `now` (an open item that isn't snoozed), `later` (only
 * snoozed ones), or not at all. By its items as the daemon has them; by the thread's own word
 * when its items aren't here.
 */
function waitsOn(thread: ThreadView, items: readonly QueueItem[]): 'now' | 'later' | null {
	const mine = items.filter((i) => i.threadId === thread.id);
	if (mine.length === 0) {
		return thread.activity === 'needs-you' ? 'now' : thread.activity === 'snoozed' ? 'later' : null;
	}
	return mine.some((i) => !isSnoozed(i)) ? 'now' : 'later';
}

/** What a thread needing you is waiting for, in a word. */
const ASKS: Record<QueueItem['kind'], string> = {
	question: 'asking',
	permission: 'allow?',
	proposal: 'build?',
	finished: 'review',
	error: 'failed'
};

/**
 * The thread's dot and word: what it waits for (asking, allow?, build?, review, failed),
 * snoozed, what it is doing (discussing, building), done, or new (never started). A failed
 * turn is an error item, so a thread whose last turn failed never reads "done".
 */
export function rowOf(thread: ThreadView, items: readonly QueueItem[]): Row {
	const waits = waitsOn(thread, items);
	if (waits === 'now') {
		const first = items.find((i) => i.threadId === thread.id && !isSnoozed(i));
		return { thread, tone: 'clay', word: ASKS[first?.kind ?? 'question'] };
	}
	if (waits === 'later') return { thread, tone: 'quiet', word: 'snoozed' };
	if (thread.activity === 'working') return { thread, tone: 'working', word: thread.phase };
	if (thread.lastSeq === 0) return { thread, tone: 'quiet', word: 'new' };
	return { thread, tone: 'done', word: 'done' };
}

/** Same calendar day where the viewer is. */
function sameDay(a: number, b: number): boolean {
	const x = new Date(a);
	const y = new Date(b);
	return (
		x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
	);
}
