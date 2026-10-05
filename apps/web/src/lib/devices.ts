import type { Device } from '@tenzo/client-runtime';
import { ageLabel } from './pass.ts';

/** One device's line under its name: "Paired 3d ago · seen 4m ago". */
export function deviceLine(device: Device, now: number): string {
	const paired = ageLabel(device.createdAt, now);
	const seen = device.lastSeenAt ? ageLabel(device.lastSeenAt, now) : null;
	const when = (age: string) => (age === 'now' ? 'just now' : `${age} ago`);
	return seen === null ? `Paired ${when(paired)}` : `Paired ${when(paired)} · seen ${when(seen)}`;
}

/** This device, if it is a paired one, and the others in the daemon's order (oldest first). */
export function splitDevices(
	devices: readonly Device[],
	current: string | null
): { mine: Device | null; others: Device[] } {
	return {
		mine: devices.find((d) => d.id === current) ?? null,
		others: devices.filter((d) => d.id !== current)
	};
}
