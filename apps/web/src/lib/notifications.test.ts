import { describe, expect, it } from 'vitest';
import {
	isOpenMessage,
	itemParam,
	notificationOf,
	pickWindow,
	readPushData,
	resubscribeCommand,
	safePath,
	staleTags
} from './notifications.ts';

const ORIGIN = 'https://my-mac.tail0000.ts.net:8443';

describe('a pushed notification', () => {
	it("shows the daemon's message, one per thread, buzzing again when replaced", () => {
		expect(
			notificationOf({
				tag: 'thr_aaaaaaaaaaaaaaaaaaaa',
				title: 'Fix login',
				body: 'Which auth method?',
				url: '/?item=itm_aaaaaaaaaaaaaaaaaaaa'
			}, ORIGIN)
		).toEqual({
			title: 'Fix login',
			options: {
				body: 'Which auth method?',
				tag: 'thr_aaaaaaaaaaaaaaaaaaaa',
				renotify: true,
				icon: '/icon-192.png',
				data: { url: '/?item=itm_aaaaaaaaaaaaaaaaaaaa' }
			}
		});
	});

	it('still shows something for a push it can’t read: iOS ends silent subscriptions', () => {
		for (const data of [null, 'text', 42, {}, { title: 7, body: ['x'] }]) {
			const shown = notificationOf(data, ORIGIN);
			expect(shown.title).toBe('Tenzo');
			expect(shown.options.body).toBe('A thread needs you.');
			expect(shown.options.data.url).toBe('/');
		}
	});

	it('reads JSON data, and nothing else', () => {
		expect(readPushData({ json: () => ({ a: 1 }) })).toEqual({ a: 1 });
		expect(
			readPushData({
				json: () => {
					throw new SyntaxError('not JSON');
				}
			})
		).toBeNull();
		expect(readPushData(null)).toBeNull();
	});

	it("goes only to Tenzo's own pages", () => {
		expect(safePath('/?item=itm_x', ORIGIN)).toBe('/?item=itm_x');
		expect(safePath('/devices', ORIGIN)).toBe('/devices');
		expect(safePath('/a/../devices#x', ORIGIN)).toBe('/devices#x');
		for (const bad of [
			'//evil.example/',
			'https://evil.example/',
			'javascript:alert(1)',
			'/\\evil.example',
			'/\t/evil.example',
			'/\n/evil.example',
			'/ /evil.example',
			'/\u0000/evil.example',
			7
		]) {
			expect(safePath(bad, ORIGIN), String(bad)).toBe('/');
		}
		expect(notificationOf({ url: '//evil.example' }, ORIGIN).options.data.url).toBe('/');
		expect(notificationOf({ url: '/\t/evil.example' }, ORIGIN).options.data.url).toBe('/');
	});

	it('is cut to size', () => {
		const shown = notificationOf({ title: 'T'.repeat(500), body: 'B'.repeat(500) }, ORIGIN);
		expect(shown.title.length).toBeLessThanOrEqual(80);
		expect(shown.options.body.length).toBeLessThanOrEqual(200);
	});
});

describe('a tap', () => {
	const w = (focused: boolean, visibilityState: DocumentVisibilityState, name: string) => ({
		focused,
		visibilityState,
		name
	});

	it('brings forward the focused window, else a visible one, else any; none opens the app', () => {
		expect(pickWindow([w(false, 'hidden', 'a'), w(true, 'visible', 'b')])?.name).toBe('b');
		expect(pickWindow([w(false, 'hidden', 'a'), w(false, 'visible', 'b')])?.name).toBe('b');
		expect(pickWindow([w(false, 'hidden', 'a')])?.name).toBe('a');
		expect(pickWindow([])).toBeUndefined();
	});

	it('tells an open window which card', () => {
		expect(isOpenMessage({ type: 'tenzo.open', url: '/?item=x' })).toBe(true);
		expect(isOpenMessage({ type: 'other', url: '/' })).toBe(false);
		expect(isOpenMessage(null)).toBe(false);
	});

	it('names the card in the link, if it is one', () => {
		expect(itemParam('?item=itm_abcdefghij0123456789')).toBe('itm_abcdefghij0123456789');
		expect(itemParam('?item=nope')).toBeNull();
		expect(itemParam('')).toBeNull();
	});
});

describe('stale notifications', () => {
	const card = (threadId: string, over: Partial<{ lane: string; snoozedUntil: string | null }> = {}) => ({
		threadId,
		lane: 'quick',
		snoozedUntil: null,
		...over
	});

	it("are those of threads with no awake quick-lane card; a test's stays", () => {
		const tags = ['thr_a', 'thr_b', 'thr_c', 'thr_d', 'tenzo-test'];
		const items = [
			card('thr_a'),
			card('thr_b', { lane: 'review' }),
			card('thr_c', { snoozedUntil: '2026-10-05T12:00:00Z' })
		];
		expect(staleTags(tags, items)).toEqual(['thr_b', 'thr_c', 'thr_d']);
	});
});

describe('a rotated subscription', () => {
	it('goes to the daemon as this device’s new one, keys and all', () => {
		const json = {
			endpoint: 'https://fcm.googleapis.com/fcm/send/new',
			expirationTime: null,
			keys: { p256dh: 'BKey', auth: 'auth' }
		};
		expect(resubscribeCommand(json)).toEqual({ type: 'device.subscribe', subscription: json });
		expect(resubscribeCommand({ endpoint: 'https://fcm.googleapis.com/x' })).toBeNull();
	});
});
