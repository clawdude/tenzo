// Tenzo's service worker: notifications only (Web Push, PRODUCT.md §9). It caches nothing and
// handles no fetch: the app's data comes over the WebSocket, and offline is not a mode Tenzo has.
// iOS needs it (with the home-screen app) for push at all. The logic is in lib/notifications.ts,
// where it is tested.

import {
	notificationOf,
	type OpenMessage,
	pickWindow,
	readPushData,
	resubscribeCommand,
	safePath
} from '../lib/notifications.ts';

const sw = self as unknown as ServiceWorkerGlobalScope;
const origin = sw.location.origin;

// A new version takes over at once: there is nothing cached to keep consistent.
sw.addEventListener('install', () => void sw.skipWaiting());
sw.addEventListener('activate', (event) => event.waitUntil(sw.clients.claim()));

// Every push shows a notification: iOS ends a subscription whose pushes show nothing.
sw.addEventListener('push', (event) => {
	const { title, options } = notificationOf(readPushData(event.data), origin);
	event.waitUntil(sw.registration.showNotification(title, options));
});

// A tap: the app comes forward on that card. An open window is focused and told where to go;
// otherwise the app opens there.
sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url = safePath((event.notification.data as { url?: unknown } | null)?.url, origin);
	event.waitUntil(
		(async () => {
			const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
			const target = pickWindow(windows);
			if (target) {
				const focused = await target.focus().catch(() => target);
				focused.postMessage({ type: 'tenzo.open', url } satisfies OpenMessage);
				return;
			}
			await sw.clients.openWindow(url);
		})()
	);
});

/** What `pushsubscriptionchange` carries (not in every browser's types). */
interface SubscriptionChange extends ExtendableEvent {
	oldSubscription?: PushSubscription | null;
	newSubscription?: PushSubscription | null;
}

// The push service rotated the subscription (or dropped it): subscribe again with the same key
// and give the daemon the new one, as this device (its cookie goes with the request). The app
// also sends its subscription each time it opens, which covers browsers that never fire this.
sw.addEventListener('pushsubscriptionchange', (event) => {
	const change = event as SubscriptionChange;
	change.waitUntil(
		(async () => {
			let subscription = change.newSubscription ?? null;
			const key = change.oldSubscription?.options.applicationServerKey ?? null;
			if (!subscription && key) {
				subscription = await sw.registration.pushManager.subscribe({
					userVisibleOnly: true,
					applicationServerKey: key
				});
			}
			const command = subscription ? resubscribeCommand(subscription.toJSON()) : null;
			if (!command) return;
			await fetch('/api/commands', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(command),
				credentials: 'same-origin'
			}).catch(() => undefined);
		})()
	);
});
