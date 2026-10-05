import { describe, expect, it } from 'vitest';
import { deviceLine, splitDevices } from './devices.ts';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const device = (id: string, createdAt: string, lastSeenAt: string | null = null) => ({
	id,
	name: id,
	createdAt,
	lastSeenAt
});

describe('devices', () => {
	it('says when a device was paired and last seen', () => {
		expect(deviceLine(device('a', '2026-10-02T12:00:00Z', '2026-10-05T11:56:00Z'), NOW)).toBe(
			'Paired 3d ago · seen 4m ago'
		);
		expect(deviceLine(device('a', '2026-10-05T12:00:00Z'), NOW)).toBe('Paired just now');
	});

	it('tells this device from the others', () => {
		const list = [device('a', 't'), device('b', 't'), device('c', 't')];
		const split = splitDevices(list, 'b');
		expect(split.mine?.id).toBe('b');
		expect(split.others.map((d) => d.id)).toEqual(['a', 'c']);
		expect(splitDevices(list, null)).toEqual({ mine: null, others: list });
	});
});
