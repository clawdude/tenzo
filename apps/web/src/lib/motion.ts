import { type AnimationConfig, flip } from 'svelte/animate';
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

/*
 * Svelte hands a transition `params ?? {}`: a null or undefined parameter arrives as `{}`. So the
 * parameters below are objects, never a bare null, and each helper reads them defensively: a
 * side that isn't -1 or 1, or an offset that isn't a finite number, falls back to the plain
 * motion (lifted, forward) or no offset, never to a NaN in a keyframe.
 */

/** -1 (left) or 1 (right); anything else: no side. */
function sideOf(value: unknown): -1 | 1 | null {
	return value === -1 || value === 1 ? value : null;
}

/** A finite number of px, else 0. */
function offsetOf(value: unknown): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** How a card leaves the top of the pile: lifted (answered), or flung aside (snoozed). */
export type Departure = { kind: 'lift' } | { kind: 'fling'; direction: -1 | 1; from: number };

/**
 * A card leaving: lifted up and away when answered, or carried on off the side it was swiped to,
 * from where the finger let go, when snoozed.
 */
export function leave(node: Element, how: Departure | null | undefined): TransitionConfig {
	if (how?.kind !== 'fling') return lift(node);
	const direction = sideOf(how.direction);
	if (direction === null) return lift(node);
	if (still()) return { duration: 0 };
	const from = offsetOf(how.from);
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
 * Where a card arriving on top comes from: `side` null, forward out of the pile; -1 or 1, back in
 * from the side it was swiped off to (Undo, a refused snooze).
 */
export interface Arrival {
	side: -1 | 1 | null;
}

/**
 * A card arriving on top: forward from the pile, or, brought back by Undo, in from the side it
 * was swiped off to.
 */
export function arrive(node: Element, how: Arrival | null | undefined): TransitionConfig {
	const side = sideOf(how?.side);
	if (side === null) return forward(node);
	if (still()) return { duration: 0 };
	return {
		duration: PACE,
		easing: ease,
		css: (t, u) =>
			`transform: translateX(${side * AWAY * u}px) rotate(${side * TURN * u}deg); opacity: ${t};`
	};
}

/**
 * A Threads row moving to where it is now: into another group (working → needs you) or along its
 * own. It slides there, so you see where it went.
 */
export function move(node: Element, rects: { from: DOMRect; to: DOMRect }): AnimationConfig {
	return flip(node, rects, { duration: still() ? 0 : PACE, easing: ease });
}

/**
 * A row or heading coming into the list: it fades up into place. Not while the list first draws
 * (`live` false): only what arrives while you look moves.
 */
export function appear(_node: Element, live: boolean): TransitionConfig {
	if (live !== true || still()) return { duration: 0 };
	return {
		duration: PACE,
		easing: ease,
		css: (t, u) => `opacity: ${t}; transform: translateY(${8 * u}px) scale(${1 - 0.02 * u});`
	};
}

/** A row or heading leaving the list (archived, or its group emptied): it fades where it was. */
export function vanish(_node: Element): TransitionConfig {
	if (still()) return { duration: 0 };
	return { duration: 200, easing: ease, css: (t) => `opacity: ${t};` };
}
