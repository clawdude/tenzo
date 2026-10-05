import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TransitionConfig } from 'svelte/transition';
import { appear, arrive, type Arrival, type Departure, forward, leave, lift } from './motion.ts';

const node = {} as Element;

/** Every frame's css, the way Svelte samples it into keyframes. */
function frames(config: TransitionConfig): string[] {
	if (!config.css) return [];
	return Array.from({ length: 11 }, (_, i) => {
		const t = i / 10;
		return config.css!(t, 1 - t);
	});
}

function expectFinite(config: TransitionConfig) {
	for (const frame of frames(config)) expect(frame).not.toMatch(/NaN|Infinity|undefined/);
}

/** What a template might hand over: Svelte turns a missing parameter into `{}`. */
const junk = [undefined, null, {}, { side: undefined }, { side: Number.NaN }, { side: 0 }];

afterEach(() => vi.unstubAllGlobals());

describe('arrive', () => {
	it('comes forward from the pile when it has no side', () => {
		for (const how of junk) {
			const config = arrive(node, how as Arrival);
			expect(frames(config)).toEqual(frames(forward(node)));
			expectFinite(config);
		}
	});

	it('comes in from the side it was swiped off to', () => {
		const left = arrive(node, { side: -1 });
		expectFinite(left);
		expect(left.css!(0, 1)).toContain('translateX(-520px) rotate(-14deg)');
		expect(arrive(node, { side: 1 }).css!(0, 1)).toContain('translateX(520px) rotate(14deg)');
		expect(left.css!(1, 0)).toContain('translateX(0px) rotate(0deg)');
	});
});

describe('leave', () => {
	it('lifts away when it was not flung', () => {
		for (const how of [undefined, null, {}, { kind: 'lift' }]) {
			const config = leave(node, how as Departure);
			expect(frames(config)).toEqual(frames(lift(node)));
			expectFinite(config);
		}
	});

	it('lifts away when the fling has no side', () => {
		for (const direction of [undefined, 0, Number.NaN]) {
			const how = { kind: 'fling', direction, from: 40 } as unknown as Departure;
			expect(frames(leave(node, how))).toEqual(frames(lift(node)));
		}
	});

	it('flies off from where the finger let go', () => {
		const config = leave(node, { kind: 'fling', direction: 1, from: 132 });
		expectFinite(config);
		expect(config.css!(1, 0)).toContain('translateX(132px) rotate(6deg)');
		expect(config.css!(0, 1)).toContain('translateX(520px) rotate(14deg)');
	});

	it('flies off from where it sits when the offset is missing, zero or not a number', () => {
		for (const from of [undefined, 0, Number.NaN, Number.POSITIVE_INFINITY]) {
			const how = { kind: 'fling', direction: -1, from } as unknown as Departure;
			const config = leave(node, how);
			expectFinite(config);
			expect(config.css!(1, 0)).toContain('translateX(0px) rotate(0deg)');
			expect(config.css!(0, 1)).toContain('translateX(-520px) rotate(-14deg)');
		}
	});
});

describe('appear', () => {
	it('only moves rows that arrive while you look', () => {
		expect(appear(node, false).duration).toBe(0);
		expect(appear(node, {} as unknown as boolean).duration).toBe(0);
		expectFinite(appear(node, true));
	});
});

describe('reduced motion', () => {
	it('changes cards in place', () => {
		vi.stubGlobal('matchMedia', (query: string) => ({
			matches: query === '(prefers-reduced-motion: reduce)'
		}));
		for (const config of [
			arrive(node, { side: null }),
			arrive(node, { side: 1 }),
			arrive(node, {} as Arrival),
			leave(node, { kind: 'lift' }),
			leave(node, { kind: 'fling', direction: -1, from: Number.NaN }),
			leave(node, {} as Departure),
			appear(node, true)
		]) {
			expect(config.duration).toBe(0);
			expect(config.css).toBeUndefined();
		}
	});
});
