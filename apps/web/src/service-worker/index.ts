// Tenzo's service worker: notifications only (Web Push, PRODUCT.md §9). It caches nothing and
// handles no fetch: the app's data comes over the WebSocket, and offline is not a mode Tenzo has.
// iOS needs it (with the home-screen app) for push at all. The logic is in lib/notifications.ts,
// where it is tested.

import {
	notificationOf,
	type OpenMessage,
	pickWindow,
	readPushData,
	safePath
} from '../lib/notifications.ts';

const sw = self as unknown as ServiceWorkerGlobalScope;

// A new version takes over at once: there is nothing cached to keep consistent.
sw.addEventListener('install', () => void sw.skipWaiting());
sw.addEventListener('activate', (event) => event.waitUntil(sw.clients.claim()));

// Every push shows a notification: iOS ends a subscription whose pushes show nothing.
sw.addEventListener('push', (event) => {
	const { title, options } = notificationOf(readPushData(event.data));
	event.waitUntil(sw.registration.showNotification(title, options));
});

// A tap: the app comes forward on that card. An open window is focused and told where to go;
// otherwise the app opens there.
sw.addEventListener('notificationclick', (event) => {
	event.notification.close();
	const url = safePath((event.notification.data as { url?: unknown } | null)?.url);
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
