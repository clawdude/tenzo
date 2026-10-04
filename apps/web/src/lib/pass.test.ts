import { describe, expect, it } from 'vitest';
import { type QueueItem, suggestedAnswer } from '@tenzo/client-runtime';
import { at, failure, finished, item, permission, proposal, question, ready } from './fixtures.ts';
import {
	ageLabel,
	answerOf,
	byLaneThenAge,
	LANES,
	minutesUntil,
	othersLabel,
	pileEdges,
	pileOf,
	snoozedLabel,
	stepsOf
} from './pass.ts';

const t0 = Date.parse(at);
const later = (minutes: number) => new Date(t0 + minutes * 60_000).toISOString();

describe('pileEdges', () => {
	it('shows one edge per card waiting behind the current one, up to four', () => {
		expect([0, 1, 2, 3, 4, 5, 6, 40].map(pileEdges)).toEqual([0, 0, 1, 2, 3, 4, 4, 4]);
	});
});

describe('lanes', () => {
	it('serves the quick lane before the review lane', () => {
		expect(LANES).toEqual(['quick', 'review']);
	});

	it('orders by lane, then oldest first, whatever order the items came in', () => {
		const newQuick = item('a', { createdAt: later(9) });
		const oldReview = item('b', { lane: 'review', createdAt: later(1) });
		const oldQuick = item('c', { createdAt: later(2) });
		const newReview = item('d', { lane: 'review', createdAt: later(5) });
		const sorted = [newReview, newQuick, oldReview, oldQuick].sort(byLaneThenAge);
		expect(sorted.map((i) => i.id)).toEqual([oldQuick.id, newQuick.id, oldReview.id, newReview.id]);
	});

	it('keeps the order of equal ones', () => {
		const [a, b] = [item('a'), item('b')];
		expect([a, b].sort(byLaneThenAge)).toEqual([a, b]);
		expect([b, a].sort(byLaneThenAge)).toEqual([b, a]);
	});
});

describe('pileOf', () => {
	it('puts the quick lane first, oldest first, without the cards leaving', () => {
		const a = item('a');
		const b = item('b', { lane: 'review' });
		const c = item('c');
		const d = item('d');
		const ids = (leaving: string[]) =>
			pileOf([a, b, c, d], { leaving: new Set(leaving) }).map((i) => i.id);
		expect(ids([])).toEqual([a.id, c.id, d.id, b.id]);
		expect(ids([a.id])).toEqual([c.id, d.id, b.id]);
	});

	it('leaves snoozed items off the pile, its edges included, until the daemon wakes them', () => {
		const a = item('a');
		const b = item('b', { snoozedUntil: later(15) });
		const c = item('c');
		expect(pileOf([a, b, c]).map((i) => i.id)).toEqual([a.id, c.id]);
		expect(pileEdges(pileOf([a, b, c]).length)).toBe(1);
		// Woken (`item.unsnoozed`): back on the pile.
		expect(pileOf([a, { ...b, snoozedUntil: null }, c]).map((i) => i.id)).toEqual([
			a.id,
			b.id,
			c.id
		]);
	});

	it("never trusts this device's clock to decide: one 20 minutes off still agrees with the daemon", () => {
		// The daemon snoozed it until 10:15 by its clock. This phone thinks it's 10:35 already.
		const snoozed = item('b', { snoozedUntil: later(15) });
		const awake = item('a');
		const realNow = Date.now;
		Date.now = () => t0 + 35 * 60_000;
		try {
			expect(pileOf([awake, snoozed]).map((i) => i.id)).toEqual([awake.id]);
		} finally {
			Date.now = realNow;
		}
		// And a phone running behind still shows a woken one.
		Date.now = () => t0 - 60 * 60_000;
		try {
			expect(pileOf([awake, { ...snoozed, snoozedUntil: null }])).toHaveLength(2);
		} finally {
			Date.now = realNow;
		}
	});

	it('keeps the card in front in front while others arrive or come back behind it', () => {
		const review = item('r', { lane: 'review', createdAt: later(1) });
		const quick = item('q', { createdAt: later(2) });
		const back = item('o', { createdAt: later(0) }); // older, returning from a snooze
		expect(pileOf([review, quick, back], { front: review.id }).map((i) => i.id)).toEqual([
			review.id,
			back.id,
			quick.id
		]);
		// Gone (answered, snoozed): the front falls back to the usual order.
		expect(pileOf([review, quick, back], { front: 'itm_gone', leaving: new Set() })[0]?.id).toBe(
			back.id
		);
		expect(pileOf([review, quick], { front: review.id, leaving: new Set([review.id]) })[0]).toBe(
			quick
		);
	});
});

describe('snooze times', () => {
	it("counts down by the daemon's clock: this device's plus the connection's offset", () => {
		const until = later(15); // set by the daemon at t0, its clock
		// A phone 20 minutes ahead: its own clock would say "already back".
		const phone = t0 + 20 * 60_000;
		const offset = -20 * 60_000;
		expect(snoozedLabel('Refresh tokens', until, phone + offset)).toBe(
			'Refresh tokens · back in 15 min'
		);
		// A phone 5 minutes behind would say 20.
		expect(minutesUntil(until, t0 - 5 * 60_000 + 5 * 60_000)).toBe(15);
	});

	it('says how long in whole minutes, never zero', () => {
		expect(minutesUntil(later(15), t0)).toBe(15);
		expect(minutesUntil(later(14.2), t0)).toBe(15);
		expect(minutesUntil(later(0.1), t0)).toBe(1);
		expect(minutesUntil(later(-2), t0)).toBe(1);
		expect(snoozedLabel('Refresh tokens', later(15), t0)).toBe('Refresh tokens · back in 15 min');
		expect(snoozedLabel('', later(15), t0)).toBe('Snoozed · back in 15 min');
	});
});

describe('error cards', () => {
	it('offer Retry on the filled button, Archive folded, and words to tell it', () => {
		const e = failure('e');
		const [step] = stepsOf(e);
		expect(step).toMatchObject({
			ask: "Claude's turn failed",
			suggested: { label: 'Retry', value: 'retry' },
			recommended: false,
			others: [{ label: 'Archive', value: 'archive' }],
			placeholder: 'Tell it something'
		});
		expect(answerOf(e, [{ choice: step!.suggested! }])).toEqual({ kind: 'error', action: 'retry' });
		expect(answerOf(e, [{ choice: step!.others[0]! }])).toEqual({
			kind: 'error',
			action: 'archive'
		});
		expect(answerOf(e, [{ text: ' Use pnpm, not npm ' }])).toEqual({
			kind: 'error',
			action: 'tell',
			text: 'Use pnpm, not npm'
		});
	});

	it('puts finished work behind every card where an agent is stuck, however old it is', () => {
		const done = finished('f', {});
		const older = { ...finished('g'), createdAt: '2026-10-01T00:00:00.000Z' };
		const ask = item('q', { createdAt: '2026-10-05T00:00:00.000Z' }); // newer than the proposal
		const build = proposal('p');
		expect(pileOf([older, done, ask, build]).map((i) => i.kind)).toEqual([
			'proposal',
			'question',
			'finished',
			'finished'
		]);
		expect(pileOf([older, done, ask]).at(-1)?.id).toBe(done.id);
	});
});

describe('stepsOf', () => {
	it("puts the agent's recommendation on the filled button and folds the rest", () => {
		const [step] = stepsOf(item('a', { questions: [question('Which?', ['A', 'B', 'C'], 'B')] }));
		expect(step?.suggested).toEqual({ label: 'B', value: 'B (Recommended)', description: 'Why B' });
		expect(step?.recommended).toBe(true);
		expect(step?.others.map((o) => o.label)).toEqual(['A', 'C']);
	});

	it('falls back to the first option when nothing is recommended', () => {
		const [step] = stepsOf(item('a', { questions: [question('Which?', ['A', 'B', 'C'])] }));
		expect(step?.suggested?.label).toBe('A');
		expect(step?.recommended).toBe(false);
		expect(step?.others.map((o) => o.label)).toEqual(['B', 'C']);
	});

	it('has one step per question', () => {
		const steps = stepsOf(
			item('a', { questions: [question('One?', ['A', 'B']), question('Two?', ['C', 'D'], 'D')] })
		);
		expect(steps.map((s) => [s.ask, s.suggested?.label])).toEqual([
			['One?', 'A'],
			['Two?', 'D']
		]);
	});

	it('offers Allow on a permission request, with Deny folded', () => {
		const [step] = stepsOf(permission('p'));
		expect(step).toMatchObject({
			ask: 'Allow Bash: uname -a?',
			suggested: { label: 'Allow', value: 'allow' },
			recommended: true,
			placeholder: 'Or say why not'
		});
		expect(step?.others.map((o) => o.label)).toEqual(['Deny']);
		expect(stepsOf(permission('p', null))[0]?.suggested?.label).toBe('Allow');
	});

	it('offers Build it on a proposal, the headline as the ask; the field changes something', () => {
		expect(stepsOf(proposal('p'))).toEqual([
			{
				key: 'proposal',
				ask: 'Add CONTRIBUTING.md',
				suggested: { label: 'Build it', value: 'build', description: '' },
				recommended: false,
				others: [],
				row: [],
				placeholder: 'Change something'
			}
		]);
	});

	it('has no filled button for a question without options', () => {
		const [step] = stepsOf(item('a', { questions: [question('Anything else?', [])] }));
		expect(step?.suggested).toBeNull();
		expect(step?.others).toEqual([]);
	});
});

describe('stepsOf: finished work', () => {
	it('offers Merge filled, Open PR and Done in the row, and the field for Needs changes', () => {
		const [step, ...rest] = stepsOf(finished('f'));
		expect(rest).toEqual([]);
		expect(step).toEqual({
			key: 'finished',
			ask: 'Counter works',
			suggested: { label: 'Merge', value: 'merge', description: '' },
			recommended: false,
			others: [],
			row: [
				{ label: 'Open PR', value: 'pr', description: '' },
				{ label: 'Done', value: 'done', description: '' }
			],
			placeholder: 'Needs changes'
		});
	});

	it('sends merge for the filled button, though one tap on everything never merges', () => {
		const card = finished('f');
		const step = stepsOf(card)[0];
		if (!step?.suggested) throw new Error('no button');
		const answer = answerOf(card, [{ choice: step.suggested }]);
		expect(answer).toEqual({ kind: 'finished', decision: 'merge' });
		expect(suggestedAnswer(card)).toEqual({ kind: 'finished', decision: 'done' });
	});

	it('sends each row button by its value, and words as what needs changing', () => {
		const card = finished('f');
		const [open, done] = stepsOf(card)[0]?.row ?? [];
		expect(answerOf(card, [{ choice: open! }])).toEqual({ kind: 'finished', decision: 'pr' });
		expect(answerOf(card, [{ choice: done! }])).toEqual({ kind: 'finished', decision: 'done' });
		expect(answerOf(card, [{ text: ' Bigger button ' }])).toEqual({
			kind: 'finished',
			decision: 'changes',
			note: 'Bigger button'
		});
	});
});

describe('stepsOf: a ready PR', () => {
	it('offers Merge, and words as what to do first', () => {
		const card = ready('r');
		const [step, ...rest] = stepsOf(card);
		expect(rest).toEqual([]);
		expect(step).toMatchObject({
			ask: 'PR #12 can merge',
			suggested: { label: 'Merge', value: 'merge' },
			row: [],
			placeholder: 'Not yet: say what first'
		});
		const merge = answerOf(card, [{ choice: step!.suggested! }]);
		expect(merge).toEqual({ kind: 'ready', decision: 'merge' });
		expect(suggestedAnswer(card)).toBeNull();
		expect(answerOf(card, [{ text: 'Wait for Ana ' }])).toEqual({
			kind: 'ready',
			decision: 'changes',
			note: 'Wait for Ana'
		});
	});

	it('is quick-lane: it goes before finished work on the pile', () => {
		expect(pileOf([finished('f'), ready('r')]).map((i) => i.kind)).toEqual([
			'ready',
			'finished'
		]);
	});
});

describe('answerOf', () => {
	const cases: [string, QueueItem][] = [
		['a recommended option', item('a')],
		['the first option', item('b', { questions: [question('Which?', ['A', 'B'])] })],
		[
			'several questions',
			item('c', {
				questions: [question('One?', ['A', 'B'], 'B'), question('Two?', ['C', 'D'])]
			})
		],
		['a permission request', permission('p')],
		['a permission request with no suggestion', permission('q', null)],
		['a proposal', proposal('r')],
		['an error', failure('s')]
	];

	it.each(cases)('sends exactly what the filled buttons say, for %s', (_, asked) => {
		const steps = stepsOf(asked);
		const picks = steps.map((s) => ({ choice: s.suggested! }));
		const answer = answerOf(asked, picks);
		// The same as the runtime's one-tap answer…
		expect(answer).toEqual(suggestedAnswer(asked));
		// …and each value sent is the value of the option whose label the button shows.
		if (answer.kind === 'question') {
			asked.questions.forEach((q, index) => {
				const shown = steps[index]!.suggested!.label;
				expect(q.options.find((o) => o.value === answer.answers[q.id])?.label).toBe(shown);
			});
		} else {
			const value = answer.kind === 'error' ? answer.action : answer.decision;
			expect(asked.options.find((o) => o.value === value)?.label).toBe(steps[0]!.suggested!.label);
		}
	});

	it('sends a folded option by its value and words as they are', () => {
		const asked = item('a', {
			questions: [question('One?', ['A', 'B'], 'A'), question('Two?', ['C', 'D'])]
		});
		const [one] = stepsOf(asked);
		expect(answerOf(asked, [{ choice: one!.others[0]! }, { text: '  neither, use E ' }])).toEqual({
			kind: 'question',
			answers: { 'One?': 'B', 'Two?': 'neither, use E' }
		});
	});

	it('denies a permission request with the words as the reason', () => {
		expect(answerOf(permission('p'), [{ text: 'use the test db ' }])).toEqual({
			kind: 'permission',
			decision: 'deny',
			message: 'use the test db'
		});
		const [step] = stepsOf(permission('p'));
		expect(answerOf(permission('p'), [{ choice: step!.others[0]! }])).toEqual({
			kind: 'permission',
			decision: 'deny'
		});
	});

	it('builds a proposal with the button, and sends words as what to change', () => {
		const p = proposal('p');
		const [step] = stepsOf(p);
		expect(answerOf(p, [{ choice: step!.suggested! }])).toEqual({ kind: 'proposal', decision: 'build' });
		expect(answerOf(p, [{ text: ' Five rules, not three ' }])).toEqual({
			kind: 'proposal',
			decision: 'change',
			note: 'Five rules, not three'
		});
	});

	it('refuses to send with a question unanswered', () => {
		const asked = item('a', { questions: [question('One?', ['A']), question('Two?', ['C'])] });
		expect(() => answerOf(asked, [{ text: 'x' }])).toThrow('"Two?" needs an answer.');
	});
});

describe('othersLabel', () => {
	it('counts the folded options, and offers to fold them back', () => {
		expect(othersLabel(1, false)).toBe('1 other option');
		expect(othersLabel(3, false)).toBe('3 other options');
		expect(othersLabel(3, true)).toBe('Fewer options');
	});
});

describe('ageLabel', () => {
	const now = Date.parse(at);
	it('says how long ago in a word', () => {
		expect(ageLabel(at, now + 20_000)).toBe('now');
		expect(ageLabel(at, now - 5_000)).toBe('now'); // a clock slightly behind the daemon's
		expect(ageLabel(at, now + 4 * 60_000)).toBe('4m');
		expect(ageLabel(at, now + 3 * 3_600_000)).toBe('3h');
		expect(ageLabel(at, now + 50 * 3_600_000)).toBe('2d');
	});
});
