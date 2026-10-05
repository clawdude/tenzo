import type { Device } from '@tenzo/client-runtime';
import { type SubscriptionInfo, subscriptionInfo } from './notifications.ts';

/**
 * This browser's side of notifications (Web Push, PRODUCT.md §9): whether it can get them,
 * subscribing with the daemon's key, and what the Devices view offers.
 */

/** What this browser can do about notifications. */
export type Support =
	/** Push works here; `permission` is the browser's answer so far. */
	| { kind: 'ready'; permission: NotificationPermission }
	/** iPhone or iPad in Safari: push needs the home-screen app. */
	| { kind: 'home-screen' }
	/** No push in this browser (or not over https). */
	| { kind: 'none' };

/** What a browser says about itself, for `supportOf`. */
export interface BrowserFacts {
	userAgent: string;
	/** `navigator.maxTouchPoints`: an iPad says "Macintosh" but has touch. */
	touchPoints: number;
	/** The page runs as an installed (home-screen) app. */
	standalone: boolean;
	/** `PushManager`, `serviceWorker` and `Notification` all exist (a secure context). */
	hasPush: boolean;
	permission: NotificationPermission | null;
}

export function supportOf(facts: BrowserFacts): Support {
	const ios =
		/iPhone|iPad|iPod/.test(facts.userAgent) ||
		(/Macintosh/.test(facts.userAgent) && facts.touchPoints > 1);
	if (facts.hasPush && facts.permission !== null) {
		return { kind: 'ready', permission: facts.permission };
	}
	// iOS has push only in a home-screen app (16.4 and later).
	if (ios && !facts.standalone) return { kind: 'home-screen' };
	return { kind: 'none' };
}

/** This browser, as `supportOf` reads it. */
export function browserFacts(): BrowserFacts {
	const hasPush =
		typeof window !== 'undefined' &&
		window.isSecureContext &&
		'serviceWorker' in navigator &&
		'PushManager' in window &&
		'Notification' in window;
	return {
		userAgent: navigator.userAgent,
		touchPoints: navigator.maxTouchPoints ?? 0,
		standalone:
			matchMedia('(display-mode: standalone)').matches ||
			(navigator as Navigator & { standalone?: boolean }).standalone === true,
		hasPush,
		permission: hasPush ? Notification.permission : null
	};
}

/** What the notifications line on a device's card says. */
export function pushLine(device: Device): string {
	if (!device.push.subscribed) return device.push.muted ? 'Notifications off · muted' : 'Notifications off';
	return device.push.muted ? 'Notifications muted' : 'Notifications on';
}

/** A base64url key (the daemon's VAPID public key) as the bytes `subscribe` takes. */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
	const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
	const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
	const raw = atob(padded);
	const bytes = new Uint8Array(new ArrayBuffer(raw.length));
	for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
	return bytes;
}

/** True when `subscription` was made with `key` (the daemon's current one). */
function madeWith(subscription: PushSubscription, key: Uint8Array): boolean {
	const own = subscription.options.applicationServerKey;
	if (!own) return false;
	const bytes = new Uint8Array(own);
	return bytes.length === key.length && bytes.every((b, i) => b === key[i]);
}

/**
 * The service worker's registration, once it is ready; null where there is none (no service
 * workers here, or it failed to register: `ready` would wait forever).
 */
async function registration(): Promise<ServiceWorkerRegistration | null> {
	if (!('serviceWorker' in navigator)) return null;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), 10_000)));
	try {
		return await Promise.race([navigator.serviceWorker.ready, late]);
	} finally {
		clearTimeout(timer);
	}
}

/** This browser's push subscription, if it has one. */
export async function currentSubscription(): Promise<PushSubscription | null> {
	const reg = await registration();
	return (await reg?.pushManager.getSubscription()) ?? null;
}

/**
 * Asks for permission (call it straight from a tap: iOS allows the prompt only then) and
 * subscribes with the daemon's key, replacing a subscription made with another key. Returns
 * what `device.subscribe` takes; throws with a sentence to show.
 */
export async function subscribeBrowser(publicKey: string): Promise<PushSubscriptionJSON> {
	const permission = await Notification.requestPermission();
	if (permission !== 'granted') {
		throw new Error(
			permission === 'denied'
				? "Notifications are blocked for Tenzo in this browser's settings."
				: 'Notifications stay off: the browser asked and got no answer.'
		);
	}
	const reg = await registration();
	if (!reg) throw new Error("This browser can't show notifications.");
	const key = keyBytes(publicKey);
	let subscription = await reg.pushManager.getSubscription();
	if (subscription && !madeWith(subscription, key)) {
		await subscription.unsubscribe();
		subscription = null;
	}
	subscription ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
	return subscription.toJSON();
}

/** What `device.subscribe` takes, from a browser's subscription; throws without keys. */
export function requireSubscriptionInfo(json: PushSubscriptionJSON): SubscriptionInfo {
	const info = subscriptionInfo(json);
	if (!info) throw new Error("The browser's push subscription has no keys; try again.");
	return info;
}

/**
 * Gives the daemon this browser's subscription again, as the app does each time it opens: a push
 * service may have rotated it (and not every browser says so to the service worker). Only with
 * permission granted and a subscription made with the daemon's current key; `device.subscribe`
 * replaces what the daemon had, so sending it again changes nothing. True when it was sent.
 */
export async function resendSubscription(
	publicKey: string | null,
	send: (subscription: SubscriptionInfo) => Promise<unknown>
): Promise<boolean> {
	if (!publicKey || typeof Notification === 'undefined' || Notification.permission !== 'granted') {
		return false;
	}
	const subscription = await currentSubscription();
	if (!subscription || !madeWith(subscription, keyBytes(publicKey))) return false;
	const info = subscriptionInfo(subscription.toJSON());
	if (!info) return false;
	await send(info);
	return true;
}

/** Drops this browser's push subscription. */
export async function unsubscribeBrowser(): Promise<void> {
	await (await currentSubscription())?.unsubscribe();
}

/** Closes the notifications whose tags `pick` returns; quietly does nothing where it can't. */
export async function closeNotifications(pick: (tags: string[]) => string[]): Promise<void> {
	try {
		const reg = await registration();
		const shown = (await reg?.getNotifications()) ?? [];
		const stale = new Set(pick(shown.map((n) => n.tag)));
		for (const notification of shown) if (stale.has(notification.tag)) notification.close();
	} catch {
		// no service worker, or no notifications API: nothing to close
	}
}
