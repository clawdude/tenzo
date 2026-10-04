import { isSnoozed, type QueueItem, type ThreadView } from '@tenzo/client-runtime';
import { ageLabel, minutesUntil } from './pass.ts';

/**
 * What the all-clear screen lists, quietly, under *Meanwhile*: the threads at work (blue), then
 * the items you snoozed, soonest back first, with how long until they are.
 */
export type MeanwhileRow =
	| { kind: 'working'; key: string; title: string; /** How long it has been going. */ age: string }
	| {
			kind: 'snoozed';
			key: string;
			itemId: string;
			title: string;
			/** "12m left". */
			left: string;
	  };

/**
 * The rows. Which items are snoozed is the daemon's word (`isSnoozed`); `daemonNow` (this
 * device's clock plus the connection's `clockOffset`) only counts down to the times it set.
 */
export function meanwhileOf(
	threads: readonly ThreadView[],
	items: readonly QueueItem[],
	daemonNow: number
): MeanwhileRow[] {
	const titles = new Map(threads.map((t) => [t.id, t.title]));
	// A thread with something open waits on you (now or later), whatever its turn is doing.
	const waiting = new Set(items.map((i) => i.threadId));
	const working: MeanwhileRow[] = threads
		.filter((t) => t.working && !waiting.has(t.id))
		.map((t) => ({
			kind: 'working',
			key: t.id,
			title: t.title,
			age: ageLabel(t.createdAt, daemonNow)
		}));
	const snoozed: MeanwhileRow[] = items
		.filter((i) => isSnoozed(i))
		.sort((a, b) => Date.parse(a.snoozedUntil ?? '') - Date.parse(b.snoozedUntil ?? ''))
		.map((i) => ({
			kind: 'snoozed',
			key: i.id,
			itemId: i.id,
			title: titles.get(i.threadId) ?? 'A thread',
			left: `${minutesUntil(i.snoozedUntil ?? '', daemonNow)}m left`
		}));
	return [...working, ...snoozed];
}
