import { cubicOut } from 'svelte/easing';
import type { TransitionConfig } from 'svelte/transition';

/** The pile's motion curve and pace, from the mock-up. */
export const PACE = 380;
const ease = (t: number) => cubicOut(t);

/** An answered card lifts up and away. */
export function lift(_node: Element): TransitionConfig {
	return {
		duration: 360,
		easing: ease,
		// Above the card already there underneath, but taps go through to that one.
		css: (t, u) =>
			`z-index: 2; pointer-events: none; transform: translateY(${-70 * u}px) scale(${1 - 0.06 * u}); opacity: ${t * t};`
	};
}

/**
 * The next card comes forward from where its edge stuck out of the pile. It is there at once:
 * the motion only says where it came from.
 */
export function forward(_node: Element): TransitionConfig {
	return {
		duration: PACE,
		easing: ease,
		css: (_t, u) => `transform: translateY(${-11 * u}px) scale(${1 - 0.035 * u});`
	};
}
