import { describe, expect, it } from 'vitest';
import { failure, finished, item, permission, proposal, thread } from './fixtures.ts';
import { groupThreads, rowOf, untilLabel } from './threads.ts';

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
		expect(rowOf(landing, [], now)).toMatchObject({ tone: 'quiet', word: 'landing' });
		const wakes = { ...landing, wakeAt: new Date(now + 12 * 60_000).toISOString() };
		expect(rowOf(wakes, [], now)).toMatchObject({ tone: 'quiet', word: 'in 12m' });
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
		expect(rowOf(t, [snoozed])).toMatchObject({ tone: 'quiet', word: 'snoozed' });
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
