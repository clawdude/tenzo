import { goto } from '$app/navigation';
import { canGoBack, EMPTY_TRAIL, follow, type Step, stepsBackTo, type Trail } from './trail.ts';

/**
 * Leaving New thread and Threads the way the back gesture would. They sit on top of the Pass in
 * the history, so leaving goes back through it; when the page was opened directly (a reload, a
 * bookmark) nothing of ours is behind it, so it is replaced instead and back never comes here.
 */

let trail: Trail = EMPTY_TRAIL;
/** The navigation under way replaces the current page (one of ours below). */
let replacing = false;

/** Records a navigation; the app's layout calls it from `afterNavigate`. */
export function track(step: Step): void {
	trail = follow(trail, step, replacing);
	replacing = false;
}

function replaceWith(path: string): void {
	replacing = true;
	void goto(path, { replaceState: true }).finally(() => (replacing = false));
}

/** Back where this screen was reached from, or to the Pass. */
export function back(): void {
	if (canGoBack(trail)) history.back();
	else replaceWith('/');
}

/** To `to` (the Pass): back to it when it is behind us, dropping what is in between. */
export function leaveTo(to = '/'): void {
	const steps = stepsBackTo(trail, to);
	if (steps !== null) history.go(steps);
	else replaceWith(to);
}
