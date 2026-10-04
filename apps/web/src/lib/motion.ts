import { cubicOut } from 'svelte/easing';
import type { TransitionConfig } from 'svelte/transition';

/** The pile's motion curve and pace, from the mock-up. */
export const PACE = 380;
const ease = (t: number) => cubicOut(t);

/** The person asked for less motion: cards change in place. */
function still(): boolean {
	return (
		typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

/**
 * An answered card lifts up and away. It stays on top while it goes and swallows taps (it has
 * answered, so it ignores them): a quick second tap must not land on the card underneath.
 */
export function lift(_node: Element): TransitionConfig {
	if (still()) return { duration: 0 };
	return {
		duration: 360,
		easing: ease,
		css: (t, u) =>
			`z-index: 2; transform: translateY(${-70 * u}px) scale(${1 - 0.06 * u}); opacity: ${t * t};`
	};
}

/**
 * The next card comes forward from where its edge stuck out of the pile. It is there at once:
 * the motion only says where it came from.
 */
export function forward(_node: Element): TransitionConfig {
	if (still()) return { duration: 0 };
	return {
		duration: PACE,
		easing: ease,
		css: (_t, u) => `transform: translateY(${-11 * u}px) scale(${1 - 0.035 * u});`
	};
}

/** How far aside a swiped card flies (px), and how much it turns on the way (deg). */
const AWAY = 520;
const TURN = 14;

/** How a card leaves the top of the pile: lifted (answered), or flung aside (snoozed). */
export type Departure = { kind: 'lift' } | { kind: 'fling'; direction: -1 | 1; from: number };

/**
 * A card leaving: lifted up and away when answered, or carried on off the side it was swiped to,
 * from where the finger let go, when snoozed.
 */
export function leave(node: Element, how: Departure | null): TransitionConfig {
	if (how?.kind !== 'fling') return lift(node);
	if (still()) return { duration: 0 };
	const { direction, from } = how;
	return {
		duration: 300,
		easing: ease,
		css: (t, u) => {
			const x = from * t + direction * AWAY * u;
			const turn = (from / 22) * t + direction * TURN * u;
			return `z-index: 2; transform: translateX(${x}px) rotate(${turn}deg); opacity: ${t};`;
		}
	};
}

/**
 * A card arriving on top: forward from the pile, or, brought back by Undo, in from the side it
 * was swiped off to.
 */
export function arrive(node: Element, from: -1 | 1 | null): TransitionConfig {
	if (from === null) return forward(node);
	if (still()) return { duration: 0 };
	return {
		duration: PACE,
		easing: ease,
		css: (t, u) =>
			`transform: translateX(${from * AWAY * u}px) rotate(${from * TURN * u}deg); opacity: ${t};`
	};
}
