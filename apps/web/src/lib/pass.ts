import {
	type ItemAnswer,
	type QueueItem,
	suggestedDecision,
	suggestedOption
} from '@tenzo/client-runtime';

/**
 * The Pass's logic, kept out of the components so it can be tested: which card is on top, how
 * tall the pile looks, and what each button on a card says and sends.
 */

/** Edges of waiting cards that stick out above the current one, at most. */
export const MAX_EDGES = 4;

/** How many edges stick out behind the current card when `waiting` cards are on the pile. */
export function pileEdges(waiting: number): number {
	return Math.max(0, Math.min(waiting - 1, MAX_EDGES));
}

/**
 * The pile, top card first: the quick lane before the review lane, oldest first within each, so
 * the card in front stays put while new ones arrive behind it. Items being answered here
 * (`leaving`) are already off the pile: their card is lifting away.
 */
export function pileOf(items: readonly QueueItem[], leaving: ReadonlySet<string>): QueueItem[] {
	const waiting = items.filter((item) => !leaving.has(item.id));
	return [
		...waiting.filter((item) => item.lane === 'quick'),
		...waiting.filter((item) => item.lane !== 'quick')
	];
}

/** One button's worth of answer: what it says, and the value it sends. */
export interface Choice {
	label: string;
	value: string;
	description: string;
}

/**
 * One question on a card. A question item asks one or more (Claude's AskUserQuestion takes up to
 * four); the card asks them one after another and sends the answers together. A permission
 * request is one step: Allow or Deny.
 */
export interface Step {
	key: string;
	ask: string;
	/** The filled button: the agent's recommendation, else the first option. */
	suggested: Choice | null;
	/** The agent marked `suggested` itself (it is not merely the first option). */
	recommended: boolean;
	/** The rest, folded behind "N other options". */
	others: Choice[];
	/** The free-text field's hint. */
	placeholder: string;
}

/** What was picked on a step: a button, or words typed or dictated into the field. */
export type Pick = { choice: Choice } | { text: string };

export function stepsOf(item: QueueItem): Step[] {
	if (item.kind === 'permission') {
		const decision = suggestedDecision(item);
		const choices = item.options.map(choiceOf);
		const suggested =
			choices.find((c) => c.value === decision) ??
			({ label: decision === 'allow' ? 'Allow' : 'Deny', value: decision, description: '' } as Choice);
		return [
			{
				key: 'permission',
				ask: item.ask,
				suggested,
				recommended: item.suggested === decision,
				others: choices.filter((c) => c.value !== suggested.value),
				placeholder: 'Or say why not'
			}
		];
	}
	return item.questions.map((question) => {
		const option = suggestedOption(question.options);
		return {
			key: question.id,
			ask: question.question || question.header,
			suggested: option ? choiceOf(option) : null,
			recommended: option?.recommended ?? false,
			others: question.options.filter((o) => o !== option).map(choiceOf),
			placeholder: "Or say what you'd prefer"
		};
	});
}

/**
 * The answer to send once every step has a pick, one pick per step in order. A button sends its
 * own `value` (so what it says is what goes); words go as they are. On a permission request,
 * words are a Deny with the reason.
 */
export function answerOf(item: QueueItem, picks: readonly Pick[]): ItemAnswer {
	if (item.kind === 'permission') {
		const pick = picks[0];
		if (!pick) throw new Error('A permission request needs a decision.');
		if ('text' in pick) return { kind: 'permission', decision: 'deny', message: pick.text.trim() };
		return { kind: 'permission', decision: pick.choice.value === 'deny' ? 'deny' : 'allow' };
	}
	const answers: Record<string, string> = {};
	item.questions.forEach((question, index) => {
		const pick = picks[index];
		if (!pick) throw new Error(`"${question.question}" needs an answer.`);
		answers[question.id] = 'text' in pick ? pick.text.trim() : pick.choice.value;
	});
	return { kind: 'question', answers };
}

/** The fold under the field: "1 other option", "2 other options", or "Fewer options" when open. */
export function othersLabel(count: number, open: boolean): string {
	if (open) return 'Fewer options';
	return count === 1 ? '1 other option' : `${count} other options`;
}

/** How long ago, in a word: "now", "4m", "3h", "2d". */
export function ageLabel(iso: string, now: number): string {
	const minutes = Math.floor((now - Date.parse(iso)) / 60_000);
	if (!(minutes >= 1)) return 'now';
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function choiceOf(option: { label: string; value: string; description: string }): Choice {
	return { label: option.label || option.value, value: option.value, description: option.description };
}
