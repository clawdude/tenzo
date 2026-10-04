import type { ItemAnswer, QueueItem } from '@tenzo/client-runtime';
import { answerOf, type Pick, stepsOf } from './pass.ts';

/**
 * Answering one card, as a pure state machine the card component drives: which question it is
 * on, whether its answer has gone, and which taps to ignore.
 *
 * Taps are ignored while a card, or a new question on it, has only just appeared. When a card
 * lifts away, the next one's clay button is exactly where the finger is, so a quick double tap
 * (or a tap aimed at a card that someone just answered elsewhere) would otherwise answer
 * something nobody read. Once the answer has gone, every tap is ignored, until the answer is
 * refused and the card is back.
 */

/** How long a card or a new question on it ignores taps, in ms: about one card motion. */
export const SETTLE_MS = 350;

export interface Answering {
	/** One pick per question answered so far; the card shows the next question. */
	readonly picks: readonly Pick[];
	/** When the current question appeared (ms, any monotonic clock). */
	readonly shownAt: number;
	/** The answer has gone; the card is lifting away. */
	readonly sent: boolean;
}

/** Why a card's last answer didn't go. A new object each time, so a repeat still counts. */
export interface Failure {
	message: string;
	/** It went out and came back refused, or was lost: the card starts over (`refused()`). */
	refused: boolean;
}

/** A card that has just appeared. */
export function fresh(now: number): Answering {
	return { picks: [], shownAt: now, sent: false };
}

/** What a tap did: the state after it, and the answer to send if it was the last pick. */
export interface Tap {
	state: Answering;
	answer: ItemAnswer | null;
}

/**
 * A pick on the current question. Ignored (state unchanged, nothing to send) once sent or while
 * the question is settling. A pick on the last question gives the answer to send, and the card
 * counts as sent; a pick on an earlier one moves to the next question, which settles anew.
 */
export function tap(item: QueueItem, state: Answering, pick: Pick, now: number): Tap {
	if (state.sent || now - state.shownAt < SETTLE_MS) return { state, answer: null };
	const picks = [...state.picks, pick];
	if (picks.length < stepsOf(item).length) {
		return { state: { picks, shownAt: now, sent: false }, answer: null };
	}
	return { state: { ...state, sent: true }, answer: answerOf(item, picks) };
}

/** The answer couldn't go out at all (offline): the card stays as it was, and can answer again. */
export function unsent(state: Answering): Answering {
	return { ...state, sent: false };
}

/**
 * The answer went but came back refused, or the connection dropped: the card is back on top,
 * asking from the first question again, and settles before it takes taps.
 */
export function refused(now: number): Answering {
	return fresh(now);
}

/**
 * A refusal the card hasn't started over for yet. The card looks again whenever anything it
 * reads changes (its item, say); the failure it has already handled must not reset the questions
 * answered since. A repeat of the same refusal is a new failure object, so it still counts.
 */
export function isNewRefusal(
	failure: Failure | null,
	handled: Failure | null
): failure is Failure {
	return failure !== null && failure.refused && failure !== handled;
}
