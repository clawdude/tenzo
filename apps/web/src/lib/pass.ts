import {
	isSnoozed,
	type LandingRule,
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
 * The lanes in the order the Pass serves them: the agent stuck waiting on you (quick) before
 * finished work waiting for a look (review). A lane not listed here goes last. With
 * `byLaneThenAge`, the one place lane order is decided.
 */
export const LANES: readonly QueueItem['lane'][] = ['quick', 'review'];

/** The pile's order: by lane (`LANES`), then oldest first. Equal ones keep their order. */
export function byLaneThenAge(a: QueueItem, b: QueueItem): number {
	return laneRank(a.lane) - laneRank(b.lane) || Date.parse(a.createdAt) - Date.parse(b.createdAt);
}

function laneRank(lane: QueueItem['lane']): number {
	const rank = LANES.indexOf(lane);
	return rank === -1 ? LANES.length : rank;
}

export interface PileOptions {
	/** Cards already off the pile: answered or swiped here, lifting or flying away. */
	leaving?: ReadonlySet<string>;
	/**
	 * The card to keep in front while it is still waiting, whatever comes in: the one being read
	 * stays put while new ones (even quick-lane ones) and returning snoozed ones go behind it.
	 * Also how Undo brings a card back to the front.
	 */
	front?: string | null;
}

/**
 * The pile, top card first: `front` if it is waiting, then by lane and age (`byLaneThenAge`).
 * Snoozed items are off it until the daemon wakes them, whatever this device's clock says.
 */
export function pileOf(
	items: readonly QueueItem[],
	{ leaving = new Set(), front = null }: PileOptions = {}
): QueueItem[] {
	const pile = items
		.filter((item) => !leaving.has(item.id) && !isSnoozed(item))
		.sort(byLaneThenAge);
	const kept = front === null ? -1 : pile.findIndex((item) => item.id === front);
	if (kept > 0) pile.unshift(...pile.splice(kept, 1));
	return pile;
}

/**
 * Whole minutes until `iso`, at least 1: a snooze is never "back in 0 min". `daemonNow` is the
 * daemon's clock (this device's plus `clockOffset`): `iso` is a time the daemon set.
 */
export function minutesUntil(iso: string, daemonNow: number): number {
	return Math.max(1, Math.ceil((Date.parse(iso) - daemonNow) / 60_000));
}

/** The snooze toast's words: "Refresh tokens · back in 15 min". */
export function snoozedLabel(title: string, until: string, daemonNow: number): string {
	const back = `back in ${minutesUntil(until, daemonNow)} min`;
	return title ? `${title} · ${back}` : `Snoozed · ${back}`;
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
 * request is one step: Allow or Deny. So is a proposal: Build it, or say what to change. And
 * finished work: Merge, Open PR or Done, or say what needs changing. And a ready PR: Merge, or
 * say what first.
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
	/** Quieter actions in a row under the field, always shown (finished work's Open PR, Done). */
	row: Choice[];
	/** The free-text field's hint; null: the card has no field. */
	placeholder: string | null;
}

/** What was picked on a step: a button, or words typed or dictated into the field. */
export type Pick = { choice: Choice } | { text: string };

/**
 * The card's steps. `landing` is the project's landing rule (`.tenzo/config.json`): which of
 * Merge and Open PR is finished work's filled button.
 */
export function stepsOf(item: QueueItem, landing: LandingRule = 'merge'): Step[] {
	if (item.kind === 'finished') {
		const merge: Choice = { label: 'Merge', value: 'merge', description: '' };
		const pr: Choice = { label: 'Open PR', value: 'pr', description: '' };
		return [
			{
				key: 'finished',
				ask: item.finished?.headline || item.ask,
				// Landing is what finished work is for: the filled button, no "Suggested" over it.
				suggested: landing === 'pr' ? pr : merge,
				recommended: false,
				others: [],
				// The other landing, and Done (nothing to land), quietly.
				row: [landing === 'pr' ? merge : pr, { label: 'Done', value: 'done', description: '' }],
				// Words are Needs changes: they go back to the agent, which builds again.
				placeholder: 'Needs changes'
			}
		];
	}
	if (item.kind === 'ready') {
		return [
			{
				key: 'ready',
				ask: item.ask,
				suggested: { label: 'Merge', value: 'merge', description: '' },
				recommended: false,
				others: [],
				row: [],
				placeholder: 'Not yet: say what first'
			}
		];
	}
	if (item.kind === 'error') {
		return [
			{
				key: 'error',
				ask: item.ask,
				// Trying again is what an error card is for, as Build it is a proposal's.
				suggested: { label: 'Retry', value: 'retry', description: '' },
				recommended: false,
				others: [{ label: 'Archive', value: 'archive', description: '' }],
				row: [],
				placeholder: 'Tell it something'
			}
		];
	}
	if (item.kind === 'proposal') {
		return [
			{
				key: 'proposal',
				ask: item.proposal?.headline || item.ask,
				// Building is what a proposal is for: the filled button, no "Suggested" over it.
				suggested: { label: 'Build it', value: 'build', description: '' },
				recommended: false,
				others: [],
				row: [],
				placeholder: 'Change something'
			}
		];
	}
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
				row: [],
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
			row: [],
			placeholder: "Or say what you'd prefer"
		};
	});
}

/**
 * The answer to send once every step has a pick, one pick per step in order. A button sends its
 * own `value` (so what it says is what goes); words go as they are. On a permission request,
 * words are a Deny with the reason; on a proposal, what to change; on an error, what to tell
 * it; on finished work, what needs changing; on a ready PR, what to do before merging.
 */
export function answerOf(item: QueueItem, picks: readonly Pick[]): ItemAnswer {
	if (item.kind === 'finished') {
		const pick = picks[0];
		if (!pick) throw new Error('Finished work needs a decision.');
		if ('text' in pick) return { kind: 'finished', decision: 'changes', note: pick.text.trim() };
		const value = pick.choice.value;
		return { kind: 'finished', decision: value === 'pr' || value === 'done' ? value : 'merge' };
	}
	if (item.kind === 'ready') {
		const pick = picks[0];
		if (!pick) throw new Error('A ready PR needs a decision.');
		if ('text' in pick) return { kind: 'ready', decision: 'changes', note: pick.text.trim() };
		return { kind: 'ready', decision: 'merge' };
	}
	if (item.kind === 'error') {
		const pick = picks[0];
		if (!pick) throw new Error('An error needs a decision.');
		if ('text' in pick) return { kind: 'error', action: 'tell', text: pick.text.trim() };
		return { kind: 'error', action: pick.choice.value === 'archive' ? 'archive' : 'retry' };
	}
	if (item.kind === 'proposal') {
		const pick = picks[0];
		if (!pick) throw new Error('A proposal needs a decision.');
		if ('text' in pick) return { kind: 'proposal', decision: 'change', note: pick.text.trim() };
		return { kind: 'proposal', decision: 'build' };
	}
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
