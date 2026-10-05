/**
 * Notifications (Web Push, PRODUCT.md §9): what the service worker shows for a push, where a tap
 * goes, and which notifications the app clears. Pure, so the service worker's logic is tested
 * here; `service-worker/index.ts` only wires it to the browser's events. It imports nothing: it
 * is part of the service worker's bundle (and type-checked against the worker's globals).
 */

/** What `staleTags` reads of a queue item. */
interface Waiting {
	threadId: string;
	lane: string;
	snoozedUntil: string | null;
}

/** What `showNotification` takes for one push. */
export interface Shown {
	title: string;
	options: {
		body: string;
		tag: string;
		/** Buzz again when a newer card replaces the thread's notification. */
		renotify: boolean;
		icon: string;
		data: { url: string };
	};
}

/** The tag of the notification a test push shows (Devices → Test). */
export const TEST_TAG = 'tenzo-test';

/**
 * The notification for a push's data (the daemon's `PushMessage`, JSON). Every push must show
 * one (iOS revokes a subscription whose pushes show nothing), so anything unreadable still
 * shows a plain "Tenzo needs you".
 */
export function notificationOf(data: unknown): Shown {
	const message = (typeof data === 'object' && data !== null ? data : {}) as Record<string, unknown>;
	const text = (value: unknown, max: number) =>
		typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
	const tag = text(message.tag, 64) || 'tenzo';
	return {
		title: text(message.title, 80) || 'Tenzo',
		options: {
			body: text(message.body, 200) || 'A thread needs you.',
			tag,
			renotify: true,
			icon: '/icon-192.png',
			data: { url: safePath(message.url) }
		}
	};
}

/** Reads a push's data as JSON; null when it isn't. */
export function readPushData(data: { json(): unknown } | null | undefined): unknown {
	try {
		return data?.json() ?? null;
	} catch {
		return null;
	}
}

/** A path on Tenzo's own origin, or the Pass: never another origin (`//evil`, `https:`). */
export function safePath(url: unknown): string {
	if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.includes('\\')) {
		return '/';
	}
	return url;
}

/** One of the app's open windows, as the service worker sees it. */
export interface AppWindow {
	focused: boolean;
	visibilityState: DocumentVisibilityState;
}

/**
 * Which open window a tap brings forward: the focused one, else a visible one, else any. None:
 * the app isn't open, so the tap opens it.
 */
export function pickWindow<W extends AppWindow>(windows: readonly W[]): W | undefined {
	return (
		windows.find((w) => w.focused) ??
		windows.find((w) => w.visibilityState === 'visible') ??
		windows[0]
	);
}

/** The message a tapped notification sends an open window: go to that card. */
export interface OpenMessage {
	type: 'tenzo.open';
	url: string;
}

export function isOpenMessage(data: unknown): data is OpenMessage {
	return (
		typeof data === 'object' &&
		data !== null &&
		(data as OpenMessage).type === 'tenzo.open' &&
		typeof (data as OpenMessage).url === 'string'
	);
}

/**
 * Notifications that no longer stand for anything: those of threads with no awake quick-lane
 * card left (answered here or elsewhere). Web Push can't take a notification back, so the app
 * clears them when it is looked at. Tags that aren't threads' (a test) are left alone.
 */
export function staleTags(tags: readonly string[], items: readonly Waiting[]): string[] {
	const waiting = new Set(
		items.filter((i) => i.lane === 'quick' && i.snoozedUntil === null).map((i) => i.threadId)
	);
	return tags.filter((tag) => tag.startsWith('thr_') && !waiting.has(tag));
}

/** The card a notification's link asks for (`/?item=…`), if any. */
export function itemParam(search: string): string | null {
	const id = new URLSearchParams(search).get('item');
	return id && /^itm_[a-z0-9]{20}$/.test(id) ? id : null;
}
