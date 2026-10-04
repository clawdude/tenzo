import { describe, expect, it } from 'vitest';
import type { ThreadView } from '@tenzo/client-runtime';
import { failure, finished, item, permission, proposal, thread } from './fixtures.ts';
import { entriesOf, groupThreads, originOf, rowOf, untilLabel } from './threads.ts';

/** A ready PR card of a given thread. */
const ready = (tag: string, overrides: Parameters<typeof item>[1] = {}) =>
	item(tag, { kind: 'ready', questions: [], ...overrides });

// Local times, so "today" means the same wherever the tests run.
const now = new Date(2026, 9, 3, 18, 0).getTime();
const morning = new Date(2026, 9, 3, 9, 30).toISOString();
const noon = new Date(2026, 9, 3, 12, 0).toISOString();
const lastNight = new Date(2026, 9, 2, 23, 0).toISOString();

describe('groupThreads', () => {
	it('puts each thread in its group, in the order Needs you, Working, Today, Earlier', () => {
		const asking = thread('a', { activity: 'needs-you', openItems: 1 });
		const busy = thread('b', { activity: 'working', working: true });
		const done = thread('c', { activeAt: noon });
		const old = thread('d', { activeAt: lastNight });
		const groups = groupThreads([old, done, busy, asking], [item('x', { threadId: asking.id })], now);
		expect(groups.map((g) => [g.label, g.rows.map((r) => r.thread.id)])).toEqual([
			['Needs you', [asking.id]],
			['Working', [busy.id]],
			['Today', [done.id]],
			['Earlier', [old.id]]
		]);
	});

	it('leaves empty groups out', () => {
		const groups = groupThreads([thread('a', { activity: 'working' })], [], now);
		expect(groups.map((g) => g.key)).toEqual(['working']);
		expect(groupThreads([], [], now)).toEqual([]);
	});

	it('keeps landing threads in Landing, working or not, however old: they never fall off', () => {
		const waiting = thread('a', { phase: 'landing', activeAt: lastNight });
		const checking = thread('b', { phase: 'landing', activity: 'working', working: true });
		const asking = thread('c', { phase: 'landing', activity: 'needs-you', openItems: 1 });
		const groups = groupThreads(
			[waiting, checking, asking],
			[ready('r', { threadId: asking.id })],
			now
		);
		expect(groups.map((g) => [g.label, g.rows.map((r) => [r.thread.id, r.word])])).toEqual([
			['Needs you', [[asking.id, 'merge?']]],
			[
				'Landing',
				[
					[waiting.id, 'landing'],
					[checking.id, 'landing']
				]
			]
		]);
	});

	it('shows the latest finished first', () => {
		const early = thread('a', { activeAt: morning });
		const late = thread('b', { activeAt: noon });
		const [today] = groupThreads([early, late], [], now);
		expect(today?.rows.map((r) => r.thread.id)).toEqual([late.id, early.id]);
	});

	it('moves a thread as it changes state', () => {
		const t = thread('a', { activity: 'working', working: true });
		expect(groupThreads([t], [], now)[0]?.key).toBe('working');
		const asking = { ...t, activity: 'needs-you' as const, openItems: 1 };
		expect(groupThreads([asking], [item('x', { threadId: t.id })], now)[0]?.key).toBe('needs-you');
		const finished = { ...t, activity: 'idle' as const, working: false, activeAt: noon };
		expect(groupThreads([finished], [], now)[0]?.key).toBe('today');
	});
});

describe('untilLabel', () => {
	it('says how long until, in a word, never less than a minute', () => {
		const at = (ms: number) => new Date(now + ms).toISOString();
		expect(untilLabel(at(-5_000), now)).toBe('1m');
		expect(untilLabel(at(30_000), now)).toBe('1m');
		expect(untilLabel(at(12 * 60_000), now)).toBe('12m');
		expect(untilLabel(at(3 * 3_600_000), now)).toBe('3h');
		expect(untilLabel(at(50 * 3_600_000), now)).toBe('2d');
	});
});

describe('rowOf', () => {
	it('says one word: asking, allow?, build?, review, discussing, building, done or new', () => {
		const asking = thread('a', { activity: 'needs-you' });
		expect(rowOf(asking, [item('x', { threadId: asking.id })])).toMatchObject({
			tone: 'clay',
			word: 'asking'
		});
		const allow = { ...permission('y'), threadId: asking.id };
		expect(rowOf(asking, [allow]).word).toBe('allow?');
		const build = { ...proposal('z'), threadId: asking.id };
		expect(rowOf(asking, [build]).word).toBe('build?');
		const review = { ...finished('w'), threadId: asking.id };
		expect(rowOf(asking, [review]).word).toBe('review');
		expect(rowOf(thread('b', { activity: 'working' }), [])).toMatchObject({
			tone: 'working',
			word: 'discussing'
		});
		expect(
			rowOf(thread('b', { activity: 'working', phase: 'building' }), [])
		).toMatchObject({ tone: 'working', word: 'building' });
		expect(rowOf(thread('c'), [])).toMatchObject({ tone: 'done', word: 'done' });
		const landing = thread('e', { phase: 'landing' });
		expect(rowOf(landing, [], now)).toMatchObject({ tone: 'waiting', word: 'landing' });
		const wakes = { ...landing, wakeAt: new Date(now + 12 * 60_000).toISOString() };
		expect(rowOf(wakes, [], now)).toMatchObject({ tone: 'waiting', word: 'in 12m' });
		expect(rowOf({ ...landing, activity: 'working' }, [], now)).toMatchObject({
			tone: 'working',
			word: 'landing'
		});
		expect(rowOf(thread('d', { lastSeq: 0 }), [])).toMatchObject({
			tone: 'quiet',
			word: 'new'
		});
	});

	it('says failed, in clay, for a thread whose last turn failed: never done', () => {
		const t = thread('a', { activity: 'needs-you' });
		const failed = { ...failure('e'), threadId: t.id };
		expect(rowOf(t, [failed])).toMatchObject({ tone: 'clay', word: 'failed' });
		expect(groupThreads([t], [failed], now)[0]?.key).toBe('needs-you');
	});

	it('says snoozed, quietly, while all its items are; needs you again once one is back', () => {
		const t = thread('a', { activity: 'snoozed', activeAt: noon });
		const until = new Date(now + 10 * 60_000).toISOString();
		const snoozed = item('x', { threadId: t.id, snoozedUntil: until });
		expect(rowOf(t, [snoozed])).toMatchObject({ tone: 'waiting', word: 'snoozed' });
		expect(groupThreads([t], [snoozed], now)[0]?.key).toBe('today');
		// Still snoozed long after its time by this device's clock: the daemon hasn't woken it.
		const late = now + 60 * 60_000;
		expect(groupThreads([t], [snoozed], late)[0]?.rows[0]?.word).toBe('snoozed');
		// Woken by the daemon: it needs you again.
		const woken = { ...snoozed, snoozedUntil: null };
		expect(rowOf(t, [woken])).toMatchObject({ tone: 'clay', word: 'asking' });
		expect(groupThreads([t], [woken], now)[0]?.key).toBe('needs-you');
		// One awake beside a snoozed one: it needs you, and says for what.
		const awake = { ...failure('e'), threadId: t.id };
		expect(rowOf(t, [snoozed, awake])).toMatchObject({ tone: 'clay', word: 'failed' });
	});
});

describe('every state has its word', () => {
	const phases: ThreadView['phase'][] = ['discussing', 'building', 'review', 'landing'];
	const activities: ThreadView['activity'][] = ['idle', 'working', 'needs-you', 'snoozed'];

	// [phase, activity] → word, dot, group: by the thread alone, its items not here.
	const table: [ThreadView['phase'], ThreadView['activity'], string, string, string][] = [
		['discussing', 'idle', 'done', 'done', 'today'],
		['discussing', 'working', 'discussing', 'working', 'working'],
		['discussing', 'needs-you', 'asking', 'clay', 'needs-you'],
		['discussing', 'snoozed', 'snoozed', 'waiting', 'today'],
		['building', 'idle', 'done', 'done', 'today'],
		['building', 'working', 'building', 'working', 'working'],
		['building', 'needs-you', 'asking', 'clay', 'needs-you'],
		['building', 'snoozed', 'snoozed', 'waiting', 'today'],
		['review', 'idle', 'done', 'done', 'today'],
		// A follow-up during review builds; "review" is only finished work waiting on you.
		['review', 'working', 'building', 'working', 'working'],
		['review', 'needs-you', 'asking', 'clay', 'needs-you'],
		['review', 'snoozed', 'snoozed', 'waiting', 'today'],
		['landing', 'idle', 'landing', 'waiting', 'landing'],
		['landing', 'working', 'landing', 'working', 'landing'],
		['landing', 'needs-you', 'asking', 'clay', 'needs-you'],
		['landing', 'snoozed', 'snoozed', 'waiting', 'landing']
	];

	it('covers every phase and activity', () => {
		expect(table.map(([p, a]) => `${p}/${a}`).sort()).toEqual(
			phases.flatMap((p) => activities.map((a) => `${p}/${a}`)).sort()
		);
	});

	it.each(table)('%s, %s: %s, %s dot, in %s', (phase, activity, word, tone, group) => {
		const t = thread('a', { phase, activity, working: activity === 'working', activeAt: noon });
		expect(rowOf(t, [], now)).toMatchObject({ word, tone });
		expect(groupThreads([t], [], now)[0]?.key).toBe(group);
	});

	it('says what each kind of item waits for', () => {
		const t = thread('a', { activity: 'needs-you' });
		const words = [
			item('q'),
			permission('p'),
			proposal('b'),
			finished('f'),
			failure('e'),
			ready('r')
		].map((i) => rowOf(t, [{ ...i, threadId: t.id }]).word);
		expect(words).toEqual(['asking', 'allow?', 'build?', 'review', 'failed', 'merge?']);
	});
});

describe('originOf', () => {
	it('says nothing for a thread you started', () => {
		expect(originOf(thread('a'), [])).toBeNull();
		expect(rowOf(thread('a'), []).origin).toBeNull();
	});

	it('names the thread whose agent started it, while that one is in the list', () => {
		const parent = thread('p', { title: 'Refresh tokens' });
		const child = thread('c', { origin: 'agent', parentId: parent.id });
		expect(originOf(child, [parent, child])).toEqual({ kind: 'agent', label: 'from Refresh tokens' });
		expect(originOf(child, [child])).toEqual({ kind: 'agent', label: 'from another thread' });
		const [group] = groupThreads([parent, child], [], now);
		expect(group?.rows.map((r) => r.origin?.label ?? null)).toEqual([null, 'from Refresh tokens']);
	});
});

describe('entriesOf', () => {
	it('runs headings and rows together, each row knowing its place in its group', () => {
		const asking = thread('a', { activity: 'needs-you' });
		const one = thread('b', { activeAt: noon });
		const two = thread('c', { activeAt: morning });
		const groups = groupThreads([asking, one, two], [item('x', { threadId: asking.id })], now);
		expect(
			entriesOf(groups).map((e) =>
				e.kind === 'head'
					? ['head', e.label, e.first]
					: ['row', e.row.thread.id, e.top, e.bottom, e.back]
			)
		).toEqual([
			['head', 'Needs you', true],
			['row', asking.id, true, true, false],
			['head', 'Today', false],
			['row', one.id, true, false, true],
			['row', two.id, false, true, true]
		]);
	});

	it('keys a row by its thread, so it is the same row in whichever group it is', () => {
		const t = thread('a', { activity: 'working', working: true });
		const before = entriesOf(groupThreads([t], [], now));
		const asking = { ...t, activity: 'needs-you' as const, working: false };
		const after = entriesOf(groupThreads([asking], [item('x', { threadId: t.id })], now));
		const key = (entries: typeof before) => entries.find((e) => e.kind === 'row')?.key;
		expect(key(after)).toBe(key(before));
		expect(after.map((e) => e.group)).toEqual(['needs-you', 'needs-you']);
	});
});
