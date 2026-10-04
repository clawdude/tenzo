import { goto } from '$app/navigation';

/**
 * Leaving a screen the way the back gesture would. New thread and Threads sit on top of the Pass
 * in the history, so going back is `history.back()`; when the page was opened directly (a
 * reload, a bookmark) there is nothing of ours behind it, so it goes to `to` instead, replacing
 * itself so back doesn't come here again.
 *
 * `from` is the path the screen was reached from (SvelteKit's `afterNavigate`), null when none.
 */
export function leave(from: string | null, to = '/'): void {
	if (from !== null && from === to) history.back();
	else void goto(to, { replaceState: true });
}

/** Back where the screen was reached from, or to the Pass. */
export function back(from: string | null): void {
	if (from !== null) history.back();
	else void goto('/', { replaceState: true });
}
