import { describe, expect, it } from 'vitest';
import { type QueueItem, suggestedAnswer } from '@tenzo/client-runtime';
import { at, finished, item, permission, proposal, question } from './fixtures.ts';
import { ageLabel, answerOf, othersLabel, pileEdges, pileOf, stepsOf } from './pass.ts';

describe('pileEdges', () => {
	it('shows one edge per card waiting behind the current one, up to four', () => {
		expect([0, 1, 2, 3, 4, 5, 6, 40].map(pileEdges)).toEqual([0, 0, 1, 2, 3, 4, 4, 4]);
	});
});

describe('pileOf', () => {
	it('puts the quick lane first, oldest first, without the cards lifting away', () => {
		const a = item('a');
		const b = item('b', { lane: 'review' });
		const c = item('c');
		const d = item('d');
		expect(pileOf([a, b, c, d], new Set()).map((i) => i.id)).toEqual([a.id, c.id, d.id, b.id]);
		expect(pileOf([a, b, c, d], new Set([a.id])).map((i) => i.id)).toEqual([c.id, d.id, b.id]);
	});

	it('puts finished work behind every card where an agent is stuck, however old it is', () => {
		const done = finished('f', {});
		const older = { ...finished('g'), createdAt: '2026-10-01T00:00:00.000Z' };
		const ask = item('q', { createdAt: '2026-10-05T00:00:00.000Z' });
		const build = proposal('p');
		expect(pileOf([older, done, ask, build], new Set()).map((i) => i.kind)).toEqual([
			'question',
			'proposal',
			'finished',
			'finished'
		]);
		expect(pileOf([older, done, ask], new Set()).at(-1)?.id).toBe(done.id);
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
	it('offers Done, no field, the headline as the ask; the row waits for #21', () => {
		const [step, ...rest] = stepsOf(finished('f'));
		expect(rest).toEqual([]);
		expect(step).toEqual({
			key: 'finished',
			ask: 'Counter works',
			suggested: { label: 'Done', value: 'done', description: '' },
			recommended: false,
			others: [],
			row: [],
			placeholder: null
		});
	});

	it('sends done, which is what taking the suggestion sends', () => {
		const card = finished('f');
		const step = stepsOf(card)[0];
		if (!step?.suggested) throw new Error('no button');
		const answer = answerOf(card, [{ choice: step.suggested }]);
		expect(answer).toEqual({ kind: 'finished', decision: 'done' });
		expect(answer).toEqual(suggestedAnswer(card));
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
		['a proposal', proposal('r')]
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
			expect(asked.options.find((o) => o.value === answer.decision)?.label).toBe(
				steps[0]!.suggested!.label
			);
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
