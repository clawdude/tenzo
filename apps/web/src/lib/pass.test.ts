import { describe, expect, it } from 'vitest';
import {
	type QueueItem,
	suggestedAnswer,
	type UserInputQuestion
} from '@tenzo/client-runtime';
import { ageLabel, answerOf, othersLabel, pileEdges, pileOf, stepsOf } from './pass.ts';

const at = '2026-10-03T10:00:00.000Z';

function question(
	text: string,
	labels: string[],
	recommended: string | null = null
): UserInputQuestion {
	return {
		id: text,
		header: '',
		question: text,
		// Claude's own label is the value; the card shows it without "(Recommended)".
		options: labels.map((label) => ({
			label,
			value: label === recommended ? `${label} (Recommended)` : label,
			description: `Why ${label}`,
			recommended: label === recommended
		})),
		multiSelect: false
	};
}

function item(tag: string, overrides: Partial<QueueItem> = {}): QueueItem {
	const questions = overrides.questions ?? [question('Which color?', ['Red', 'Blue'], 'Blue')];
	return {
		id: `itm_${tag.repeat(20).slice(0, 20)}`,
		environmentId: 'env_abcdefghij0123456789',
		threadId: 'thr_aaaaaaaaaaaaaaaaaaaa',
		lane: 'quick',
		kind: 'question',
		requestId: `req_${tag.repeat(20).slice(0, 20)}`,
		context: '',
		ask: questions[0]?.question ?? '',
		options: questions[0]?.options ?? [],
		suggested: questions[0]?.options.find((o) => o.recommended)?.value ?? null,
		questions,
		createdAt: at,
		status: 'open',
		detached: false,
		resolvedAt: null,
		resolution: null,
		...overrides
	};
}

function permission(tag: string, suggested: string | null = 'allow'): QueueItem {
	return item(tag, {
		kind: 'permission',
		ask: 'Allow Bash: uname -a?',
		options: [
			{ label: 'Allow', value: 'allow', description: '', recommended: true },
			{ label: 'Deny', value: 'deny', description: '', recommended: false }
		],
		suggested,
		questions: [],
		permission: { toolKind: 'command', toolName: 'Bash', detail: 'uname -a', input: {} }
	});
}

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

	it('has no filled button for a question without options', () => {
		const [step] = stepsOf(item('a', { questions: [question('Anything else?', [])] }));
		expect(step?.suggested).toBeNull();
		expect(step?.others).toEqual([]);
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
		['a permission request with no suggestion', permission('q', null)]
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
