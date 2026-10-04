/**
 * The app's own part of the browser history: the paths this tab has visited in the app, and
 * where it is among them. The browser won't say what is behind the current page, so the app
 * keeps count from its navigations, which is enough to leave a screen the way the back gesture
 * would: back to the Pass when it is behind us, else to it in place of this page.
 *
 * Pure, so it can be tested without a browser.
 */
export interface Trail {
	readonly paths: readonly string[];
	readonly index: number;
}

/**
 * What a navigation says, as SvelteKit's `afterNavigate` reports it. Only `to` and `delta` are
 * read. `from` is not: on the first navigation of a direct load it is `{ url: null }`, despite
 * its type, and reading `from.url.pathname` there throws inside SvelteKit's start-up.
 */
export interface Step {
	type: string;
	to: { url?: URL | null } | null;
	delta?: number | undefined;
}

export const EMPTY_TRAIL: Trail = { paths: [], index: -1 };

/** The trail after a navigation. `replaced`: it took the current page's place in the history. */
export function follow(trail: Trail, step: Step, replaced = false): Trail {
	const path = step.to?.url?.pathname;
	if (!path) return trail;
	if (step.type === 'enter' || trail.index < 0) return { paths: [path], index: 0 };
	if (step.type === 'popstate') {
		const index = trail.index + (step.delta ?? 0);
		// Somewhere the trail doesn't know (before this page load, say): start counting afresh.
		if (trail.paths[index] !== path) return { paths: [path], index: 0 };
		return { paths: trail.paths, index };
	}
	if (replaced) {
		const paths = [...trail.paths.slice(0, trail.index), path];
		return { paths, index: trail.index };
	}
	return { paths: [...trail.paths.slice(0, trail.index + 1), path], index: trail.index + 1 };
}

/** How many entries back `to` is (a negative number for `history.go`), or null when it isn't. */
export function stepsBackTo(trail: Trail, to: string): number | null {
	for (let i = trail.index - 1; i >= 0; i--) {
		if (trail.paths[i] === to) return i - trail.index;
	}
	return null;
}

/** An app page is behind this one: going back stays in the app. */
export function canGoBack(trail: Trail): boolean {
	return trail.index > 0;
}

/**
 * How this page load began, as Navigation Timing's `type` says: `navigate` (a link, a typed URL,
 * a bookmark), `reload`, or `back_forward` (back into the app from another page).
 */
export type LoadKind = 'navigate' | 'reload' | 'back_forward' | (string & {});

/**
 * The trail a page load starts from (its `enter` navigation). A reload, or a return through the
 * history, lands on an entry this tab has been on, so the trail saved before the page went away
 * still holds, provided it was on the same path. Anything else starts afresh.
 */
export function resume(saved: Trail | null, step: Step, load: LoadKind): Trail {
	const fresh = follow(EMPTY_TRAIL, step);
	const path = fresh.paths[0];
	if (!saved || (load !== 'reload' && load !== 'back_forward')) return fresh;
	return saved.paths[saved.index] === path ? saved : fresh;
}

/** Where the trail is kept for the tab (sessionStorage): it outlives a reload, not the tab. */
export const TRAIL_KEY = 'tenzo.trail';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** The trail this tab saved, or null (none, storage off, or not one). */
export function loadTrail(store: Store | null): Trail | null {
	try {
		const raw = store?.getItem(TRAIL_KEY);
		if (!raw) return null;
		const value: unknown = JSON.parse(raw);
		if (typeof value !== 'object' || value === null) return null;
		const { paths, index } = value as { paths?: unknown; index?: unknown };
		if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string' && p.startsWith('/')))
			return null;
		if (typeof index !== 'number' || !Number.isInteger(index)) return null;
		if (index < 0 || index >= paths.length) return null;
		return { paths, index };
	} catch {
		return null;
	}
}

export function saveTrail(store: Store | null, trail: Trail): void {
	try {
		store?.setItem(TRAIL_KEY, JSON.stringify(trail));
	} catch {
		// Not kept: after a reload, leaving a screen replaces it instead of going back.
	}
}
