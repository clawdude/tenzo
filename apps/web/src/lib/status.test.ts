import { describe, expect, it } from 'vitest';
import type { ConnectionSnapshot } from '@tenzo/client-runtime';
import { connectionLabel } from './status.ts';

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

	it('shows the attempt count once retries pile up', () => {
		expect(connectionLabel({ ...base, state: 'reconnecting', attempt: 3 })).toBe(
			'Reconnecting (attempt 3)…'
		);
	});
});
