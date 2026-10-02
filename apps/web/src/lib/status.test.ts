import { describe, expect, it } from 'vitest';
import type { ConnectionSnapshot } from '@tenzo/client-runtime';
import { connectionLabel, connectionTone, daemonSocketUrl } from './status.ts';

const base: ConnectionSnapshot = {
	state: 'closed',
	attempt: 0,
	environmentId: null,
	serverVersion: null
};

describe('connectionLabel', () => {
	it('names every connection state', () => {
		expect(connectionLabel(base)).toBe('Not connected');
		expect(connectionLabel({ ...base, state: 'connecting' })).toBe('Connecting…');
		expect(connectionLabel({ ...base, state: 'connected' })).toBe('Connected');
		expect(connectionLabel({ ...base, state: 'reconnecting', attempt: 1 })).toBe('Reconnecting…');
	});

	it('shows the daemon version once hello arrives', () => {
		expect(connectionLabel({ ...base, state: 'connected', serverVersion: '0.0.1' })).toBe(
			'Connected · daemon 0.0.1'
		);
	});

	it('says reconnecting, not connected, while the last known daemon is away', () => {
		const away = { ...base, state: 'reconnecting', attempt: 1, serverVersion: '0.0.1' } as const;
		expect(connectionLabel(away)).toBe('Reconnecting…');
	});

	it('shows the attempt count once retries pile up', () => {
		expect(connectionLabel({ ...base, state: 'reconnecting', attempt: 3 })).toBe(
			'Reconnecting (attempt 3)…'
		);
	});
});

describe('connectionTone', () => {
	it('is live only when connected', () => {
		expect(connectionTone({ ...base, state: 'connected' })).toBe('live');
		expect(connectionTone({ ...base, state: 'connecting' })).toBe('waiting');
		expect(connectionTone({ ...base, state: 'reconnecting', attempt: 2 })).toBe('waiting');
		expect(connectionTone(base)).toBe('off');
	});
});

describe('daemonSocketUrl', () => {
	it('uses ws: next to a plain http page', () => {
		expect(daemonSocketUrl({ protocol: 'http:', host: '127.0.0.1:4780' })).toBe(
			'ws://127.0.0.1:4780/ws'
		);
		expect(daemonSocketUrl({ protocol: 'http:', host: 'localhost:5173' })).toBe(
			'ws://localhost:5173/ws'
		);
	});

	it('uses wss: on the same host behind HTTPS (Tailscale Serve)', () => {
		expect(daemonSocketUrl({ protocol: 'https:', host: 'mini.tail1234.ts.net:8443' })).toBe(
			'wss://mini.tail1234.ts.net:8443/ws'
		);
		expect(daemonSocketUrl({ protocol: 'https:', host: 'mini.tail1234.ts.net' })).toBe(
			'wss://mini.tail1234.ts.net/ws'
		);
	});
});
