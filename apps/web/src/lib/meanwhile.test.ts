import { describe, expect, it } from 'vitest';
import { at, failure, item, thread } from './fixtures.ts';
import { meanwhileOf } from './meanwhile.ts';

const t0 = Date.parse(at);
const later = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString();

describe('meanwhileOf', () => {
	it('lists the working threads, then the snoozed items, soonest back first', () => {
		const busy = thread('a', { working: true, activity: 'working' });
		const idle = thread('b');
		const asked = thread('c', { activity: 'snoozed' });
		const failed = thread('d', { activity: 'snoozed' });
		const items = [
			item('x', { threadId: asked.id, snoozedUntil: later(12) }),
			{ ...failure('y'), threadId: failed.id, snoozedUntil: later(3) }
		];
		expect(meanwhileOf([busy, idle, asked, failed], items, t0 + 30_000)).toEqual([
			{ kind: 'working', key: busy.id, title: 'Thread a', age: 'now' },
			{ kind: 'snoozed', key: items[1]?.id, itemId: items[1]?.id, title: 'Thread d', left: '3m left' },
			{ kind: 'snoozed', key: items[0]?.id, itemId: items[0]?.id, title: 'Thread c', left: '12m left' }
		]);
	});

	it('leaves out threads waiting on you even mid-turn, and items the daemon has woken', () => {
		const waiting = thread('a', { working: true, activity: 'snoozed' });
		const snoozed = item('x', { threadId: waiting.id, snoozedUntil: later(5) });
		expect(meanwhileOf([waiting], [snoozed], t0).map((r) => r.kind)).toEqual(['snoozed']);
		expect(meanwhileOf([waiting], [{ ...snoozed, snoozedUntil: null }], t0)).toEqual([]);
		expect(meanwhileOf([], [], t0)).toEqual([]);
	});

	it("lists a snoozed item until the daemon wakes it, whatever the clock; counts down by the daemon's", () => {
		const t = thread('a', { activity: 'snoozed' });
		const snoozed = item('x', { threadId: t.id, snoozedUntil: later(5) });
		// A clock far past its time: still listed, at the floor of the countdown.
		expect(meanwhileOf([t], [snoozed], t0 + 60 * 60_000)).toMatchObject([{ left: '1m left' }]);
		// The daemon's time (the caller adds the clock offset): 5 minutes left.
		expect(meanwhileOf([t], [snoozed], t0)).toMatchObject([{ left: '5m left' }]);
	});
});
