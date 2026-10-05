import { describe, expect, it } from 'vitest';
import {
	type BrowserFacts,
	keyBytes,
	pushLine,
	requireSubscriptionInfo,
	supportOf
} from './push.ts';

const IPHONE =
	'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const MAC =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';

const facts = (over: Partial<BrowserFacts>): BrowserFacts => ({
	userAgent: MAC,
	touchPoints: 0,
	standalone: false,
	hasPush: true,
	permission: 'default',
	...over
});

describe('push support', () => {
	it('is ready where the browser has push, with its permission so far', () => {
		expect(supportOf(facts({}))).toEqual({ kind: 'ready', permission: 'default' });
		expect(supportOf(facts({ permission: 'denied' }))).toEqual({ kind: 'ready', permission: 'denied' });
		expect(
			supportOf(facts({ userAgent: IPHONE, standalone: true, permission: 'granted' }))
		).toEqual({ kind: 'ready', permission: 'granted' });
	});

	it('needs the home-screen app on iPhone and iPad', () => {
		expect(supportOf(facts({ userAgent: IPHONE, hasPush: false, permission: null }))).toEqual({
			kind: 'home-screen'
		});
		// An iPad says it is a Mac, but has touch.
		expect(
			supportOf(facts({ userAgent: MAC, touchPoints: 5, hasPush: false, permission: null }))
		).toEqual({ kind: 'home-screen' });
	});

	it('is none elsewhere without push (or over plain http)', () => {
		expect(supportOf(facts({ hasPush: false, permission: null }))).toEqual({ kind: 'none' });
		expect(
			supportOf(facts({ userAgent: IPHONE, standalone: true, hasPush: false, permission: null }))
		).toEqual({ kind: 'none' });
	});
});

describe('a device’s notifications line', () => {
	const device = (subscribed: boolean, muted: boolean) => ({
		id: 'dev_a',
		name: 'Phone',
		createdAt: 't',
		lastSeenAt: null,
		push: { subscribed, muted }
	});
	it('says on, muted or off', () => {
		expect(pushLine(device(true, false))).toBe('Notifications on');
		expect(pushLine(device(true, true))).toBe('Notifications muted');
		expect(pushLine(device(false, false))).toBe('Notifications off');
		expect(pushLine(device(false, true))).toBe('Notifications off · muted');
	});
});

describe('subscribing', () => {
	it("decodes the daemon's base64url key", () => {
		const bytes = Uint8Array.from({ length: 65 }, (_, i) => (i * 37) % 256);
		const base64url = btoa(String.fromCharCode(...bytes))
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
		expect(Array.from(keyBytes(base64url))).toEqual(Array.from(bytes));
	});

	it("takes the browser's subscription only with its keys", () => {
		const json = {
			endpoint: 'https://fcm.googleapis.com/fcm/send/x',
			expirationTime: null,
			keys: { p256dh: 'BKey', auth: 'auth' }
		};
		expect(requireSubscriptionInfo(json)).toEqual(json);
		expect(() => requireSubscriptionInfo({ endpoint: 'https://x' })).toThrow(/no keys/);
	});
});
