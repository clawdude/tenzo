import { isSnoozed, type QueueItem, type ThreadView } from '@tenzo/client-runtime';

/**
 * The Threads list's logic: which group each thread is in and the one word that says how it is.
 * Kept out of the component so it can be tested.
 */

export type GroupKey = 'needs-you' | 'working' | 'landing' | 'today' | 'earlier';

/**
 * The dot's colour: clay needs you, blue works, green is done; grey waits (landing, snoozed),
 * darker grey is quiet (never started).
 */
export type Tone = 'clay' | 'working' | 'done' | 'waiting' | 'quiet';

/**
 * Who started a thread you didn't type: another thread's agent (`start_thread`) for now;
 * automations will be the next kind.
 */
export interface Origin {
	kind: 'agent';
	/** "from Refresh tokens". */
	label: string;
}

export interface Row {
	thread: ThreadView;
	tone: Tone;
	/** One word of status. */
	word: string;
	/** Who started it, when it wasn't you. */
	origin: Origin | null;
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
		const row = rowOf(thread, items, now, threads);
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
	if (thread.phase === 'landing') return 'landing';
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
	error: 'failed',
	ready: 'merge?'
};

/**
 * The thread's dot and word: what it waits for (asking, allow?, build?, review, failed,
 * merge?), snoozed, what it is doing (discussing, building, landing), when a landing thread
 * looks again (in 12m), done, or new (never started). A failed turn is an error item, so a
 * thread whose last turn failed never reads "done".
 */
export function rowOf(
	thread: ThreadView,
	items: readonly QueueItem[],
	now = Date.now(),
	threads: readonly ThreadView[] = []
): Row {
	const { tone, word } = statusOf(thread, items, now);
	return { thread, tone, word, origin: originOf(thread, threads) };
}

function statusOf(
	thread: ThreadView,
	items: readonly QueueItem[],
	now: number
): { tone: Tone; word: string } {
	const waits = waitsOn(thread, items);
	if (waits === 'now') {
		const first = items.find((i) => i.threadId === thread.id && !isSnoozed(i));
		return { tone: 'clay', word: ASKS[first?.kind ?? 'question'] };
	}
	if (waits === 'later') return { tone: 'waiting', word: 'snoozed' };
	if (thread.activity === 'working') {
		// A follow-up during review runs straight away: it builds. "review" means work waits on you.
		return { tone: 'working', word: thread.phase === 'review' ? 'building' : thread.phase };
	}
	if (thread.phase === 'landing') {
		// Waiting on CI and reviewers: grey, with when it looks again if it said.
		const word = thread.wakeAt ? `in ${untilLabel(thread.wakeAt, now)}` : 'landing';
		return { tone: 'waiting', word };
	}
	if (thread.lastSeq === 0) return { tone: 'quiet', word: 'new' };
	return { tone: 'done', word: 'done' };
}

/**
 * Who started the thread, when it wasn't you: the thread whose agent started it, by its title
 * while it is still in the list.
 */
export function originOf(thread: ThreadView, threads: readonly ThreadView[]): Origin | null {
	switch (thread.origin) {
		case 'user':
			return null;
		case 'agent': {
			const parent = threads.find((t) => t.id === thread.parentId);
			return { kind: 'agent', label: parent ? `from ${parent.title}` : 'from another thread' };
		}
	}
}

/**
 * The list as one run of headings and rows, so a row changing group is the same element
 * moving: it slides from where it was to where it is now. `top` and `bottom` say whether a row
 * opens or closes its group (its rounded corners); `back` groups (Today, Earlier) sit a layer
 * further back.
 */
export type Entry =
	| { kind: 'head'; key: string; group: GroupKey; label: string; first: boolean }
	| { kind: 'row'; key: string; group: GroupKey; row: Row; top: boolean; bottom: boolean; back: boolean };

export function entriesOf(groups: readonly Group[]): Entry[] {
	return groups.flatMap((group, g): Entry[] => [
		{ kind: 'head', key: `group:${group.key}`, group: group.key, label: group.label, first: g === 0 },
		...group.rows.map(
			(row, i): Entry => ({
				kind: 'row',
				key: row.thread.id,
				group: group.key,
				row,
				top: i === 0,
				bottom: i === group.rows.length - 1,
				back: group.key === 'today' || group.key === 'earlier'
			})
		)
	]);
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
