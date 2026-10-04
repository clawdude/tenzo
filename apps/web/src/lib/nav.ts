import { goto } from '$app/navigation';
import {
	canGoBack,
	EMPTY_TRAIL,
	follow,
	type LoadKind,
	loadTrail,
	resume,
	saveTrail,
	type Step,
	stepsBackTo,
	type Trail
} from './trail.ts';

/**
 * Leaving New thread and Threads the way the back gesture would. They sit on top of the Pass in
 * the history, so leaving goes back through it; when the page was opened directly (a bookmark,
 * a new tab) nothing of ours is behind it, so it is replaced instead and back never comes here.
 * The trail is saved for the tab, so a reload still knows what is behind the page.
 */

let trail: Trail = EMPTY_TRAIL;
/** The navigation under way replaces the current page (one of ours below). */
let replacing = false;

/** Records a navigation; the app's layout calls it from `afterNavigate`. */
export function track(step: Step): void {
	trail =
		step.type === 'enter'
			? resume(loadTrail(tabStore()), step, loadKind())
			: follow(trail, step, replacing);
	replacing = false;
	saveTrail(tabStore(), trail);
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

function tabStore(): Storage | null {
	try {
		return globalThis.sessionStorage ?? null;
	} catch {
		return null; // storage blocked: the trail lasts as long as the page
	}
}

function loadKind(): LoadKind {
	try {
		const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
		return entry?.type ?? 'navigate';
	} catch {
		return 'navigate';
	}
}
