import type { QueueItem, ThreadView } from '@tenzo/client-runtime';

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
		rows[groupOf(thread, now)].push(row);
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

export function groupOf(thread: ThreadView, now: number): GroupKey {
	if (thread.activity === 'needs-you') return 'needs-you';
	if (thread.activity === 'working') return 'working';
	return sameDay(Date.parse(thread.activeAt), now) ? 'today' : 'earlier';
}

/** The thread's dot and word: asking, allow?, working, done, or new (never started). */
export function rowOf(thread: ThreadView, items: readonly QueueItem[]): Row {
	if (thread.activity === 'needs-you') {
		const first = items.find((i) => i.threadId === thread.id);
		return { thread, tone: 'clay', word: first?.kind === 'permission' ? 'allow?' : 'asking' };
	}
	if (thread.activity === 'working') return { thread, tone: 'working', word: 'working' };
	if (thread.lastSeq === 0) return { thread, tone: 'quiet', word: 'new' };
	// Idle after a failed turn reads "done" too, until failures become items of their own (M2).
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
