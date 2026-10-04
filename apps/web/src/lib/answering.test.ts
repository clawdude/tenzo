import { describe, expect, it } from 'vitest';
import { type Failure, fresh, isNewRefusal, refused, SETTLE_MS, tap, unsent } from './answering.ts';
import { item, permission, question } from './fixtures.ts';
import { stepsOf } from './pass.ts';

const one = item('a');
const two = item('b', {
	questions: [question('Which color?', ['Red', 'Blue'], 'Blue'), question('Which shape?', ['Round', 'Square'])]
});
const suggested = (it: typeof one, step = 0) => ({ choice: stepsOf(it)[step]!.suggested! });

describe('tap', () => {
	it('ignores taps on a card that has only just appeared', () => {
		const shown = fresh(1000);
		for (const at of [1000, 1060, 1000 + SETTLE_MS - 1]) {
			expect(tap(one, shown, suggested(one), at)).toEqual({ state: shown, answer: null });
		}
		expect(tap(one, shown, suggested(one), 1000 + SETTLE_MS).answer).toEqual({
			kind: 'question',
			answers: { 'Which color?': 'Blue (Recommended)' }
		});
	});

	it('sends once: a second tap on a card that has answered does nothing', () => {
		const first = tap(one, fresh(0), suggested(one), 1000);
		expect(first.state.sent).toBe(true);
		expect(tap(one, first.state, suggested(one), 1100)).toEqual({ state: first.state, answer: null });
		expect(tap(one, first.state, suggested(one), 5000).answer).toBeNull();
	});

	it("doesn't let a double tap answer the next question with what is under the finger", () => {
		const step1 = tap(two, fresh(0), suggested(two), 1000);
		expect(step1).toMatchObject({ answer: null, state: { shownAt: 1000, sent: false } });
		expect(step1.state.picks).toHaveLength(1);
		// The second tap of a double tap, 150ms later, lands on step 2's button: ignored.
		const double = tap(two, step1.state, suggested(two, 1), 1150);
		expect(double).toEqual({ state: step1.state, answer: null });
		// A deliberate tap once it has settled answers both.
		const step2 = tap(two, step1.state, { choice: stepsOf(two)[1]!.others[0]! }, 1000 + SETTLE_MS);
		expect(step2.answer).toEqual({
			kind: 'question',
			answers: { 'Which color?': 'Blue (Recommended)', 'Which shape?': 'Square' }
		});
	});

	it('takes words from the field the same way', () => {
		const sent = tap(permission('p'), fresh(0), { text: 'use the test db' }, 400);
		expect(sent.answer).toEqual({ kind: 'permission', decision: 'deny', message: 'use the test db' });
	});
});

describe('unsent', () => {
	it('lets the card answer again when the answer never went out', () => {
		const first = tap(one, fresh(0), suggested(one), 1000);
		const again = tap(one, unsent(first.state), suggested(one), 1001);
		expect(again.answer).not.toBeNull();
	});
});

describe('refused', () => {
	it('brings a card back that answers again, from its first question', () => {
		const step1 = tap(two, fresh(0), suggested(two), 1000);
		const sent = tap(two, step1.state, suggested(two, 1), 2000);
		expect(sent.state.sent).toBe(true);
		// Refused 50ms later, while the card was still lifting: it is back, fresh.
		const back = refused(2050);
		expect(back).toEqual({ picks: [], shownAt: 2050, sent: false });
		expect(tap(two, back, suggested(two), 2100).answer).toBeNull(); // still settling
		const again = tap(two, back, suggested(two), 2050 + SETTLE_MS);
		expect(again.state.picks).toHaveLength(1);
		expect(tap(two, again.state, suggested(two, 1), 2050 + 2 * SETTLE_MS).answer).toEqual(
			sent.answer
		);
	});
});

describe('isNewRefusal', () => {
	const refusal = (): Failure => ({ message: 'Refused for the test.', refused: true });

	it('starts the card over once per refusal, not again when the card looks again', () => {
		const first = refusal();
		expect(isNewRefusal(first, null)).toBe(true);
		// Handled: the item changing (a `detached` frame, say) mid-way through must not reset it.
		expect(isNewRefusal(first, first)).toBe(false);
		// The same words again are a new refusal.
		expect(isNewRefusal(refusal(), first)).toBe(true);
	});

	it('never starts over for no failure, or for one that never went out', () => {
		expect(isNewRefusal(null, null)).toBe(false);
		expect(isNewRefusal({ message: 'Not connected.', refused: false }, null)).toBe(false);
	});
});
