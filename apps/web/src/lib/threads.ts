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
 * The threads in their groups, in the list's order, empty groups left out. Needs you, Working and
 * Landing keep the threads' own order (oldest first); Today and Earlier show the latest active
 * first. Landing holds every thread whose work is pushed and waiting on the outside world,
 * however long ago it was last active: it can't be forgotten, and leaves only when it archives.
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
		const row = rowOf(thread, items, now);
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
	if (thread.phase === 'landing') return 'landing';
	if (thread.activity === 'working') return 'working';
	return sameDay(Date.parse(thread.activeAt), now) ? 'today' : 'earlier';
}

/** What a thread needing you is waiting for, in a word. */
const ASKS: Record<QueueItem['kind'], string> = {
	question: 'asking',
	permission: 'allow?',
	proposal: 'build?',
	finished: 'review',
	ready: 'merge?'
};

/**
 * The thread's dot and word: what it waits for (asking, allow?, build?, review, merge?), what
 * it is doing (discussing, building, landing), when a landing thread looks again (in 12m), done,
 * or new (never started).
 */
export function rowOf(thread: ThreadView, items: readonly QueueItem[], now = Date.now()): Row {
	if (thread.activity === 'needs-you') {
		const first = items.find((i) => i.threadId === thread.id);
		return { thread, tone: 'clay', word: ASKS[first?.kind ?? 'question'] };
	}
	if (thread.activity === 'working') return { thread, tone: 'working', word: thread.phase };
	if (thread.phase === 'landing') {
		// Waiting on CI and reviewers: grey, with when it looks again if it said.
		const word = thread.wakeAt ? `in ${untilLabel(thread.wakeAt, now)}` : 'landing';
		return { thread, tone: 'quiet', word };
	}
	if (thread.lastSeq === 0) return { thread, tone: 'quiet', word: 'new' };
	// Idle after a failed turn reads "done" too, until failures become items of their own (M2).
	return { thread, tone: 'done', word: 'done' };
}

/** How long until `iso`, in a word: "1m" at least, then "12m", "3h", "2d". */
export function untilLabel(iso: string, now: number): string {
	const minutes = Math.max(1, Math.ceil((Date.parse(iso) - now) / 60_000));
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

/** Same calendar day where the viewer is. */
function sameDay(a: number, b: number): boolean {
	const x = new Date(a);
	const y = new Date(b);
	return (
		x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate()
	);
}
