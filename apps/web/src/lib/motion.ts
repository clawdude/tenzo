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
