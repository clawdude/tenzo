import { describe, expect, it } from 'vitest';
import {
	begin,
	FLICK_MIN,
	type Gesture,
	MAX_DISTANCE,
	move,
	type Point,
	release,
	SLOP,
	speed
} from './swipe.ts';

const WIDTH = 358; // a card on an iPhone: the far threshold is 125px

/** A pointer path: [x, y, t] from (0, 0) at t=0, fed through the gesture. */
function path(...points: [number, number, number][]): Gesture {
	let gesture = begin({ x: 0, y: 0, t: 0 });
	for (const [x, y, t] of points) gesture = move(gesture, { x, y, t });
	return gesture;
}

const at = (x: number, y: number, t: number): Point => ({ x, y, t });

describe('picking an axis', () => {
	it('waits out a tap’s wobble', () => {
		expect(path([SLOP - 1, 3, 30]).phase).toBe('pending');
		expect(path([-4, -(SLOP - 1), 30]).phase).toBe('pending');
	});

	it('drags clearly sideways moves, either way', () => {
		const right = path([12, 2, 20]);
		expect(right).toMatchObject({ phase: 'dragging', dx: 12 });
		expect(path([-20, 6, 20])).toMatchObject({ phase: 'dragging', dx: -20 });
	});

	it('leaves up-and-down and diagonal moves to the text, for good', () => {
		expect(path([2, 14, 20]).phase).toBe('scrolling');
		expect(path([12, 11, 20]).phase).toBe('scrolling'); // about 45°: a scroll, not a swipe
		// Once scrolling, a later sideways move is still the scroll's.
		expect(path([2, 14, 20], [200, 14, 60]).phase).toBe('scrolling');
	});

	it('follows the finger once dragging, back past the start too', () => {
		expect(path([15, 0, 20], [80, 40, 60])).toMatchObject({ phase: 'dragging', dx: 80 });
		expect(path([15, 0, 20], [-30, 0, 200])).toMatchObject({ phase: 'dragging', dx: -30 });
	});
});

describe('letting go', () => {
	it('snoozes a long drag, either way, at any speed', () => {
		const slowRight = path([15, 0, 100], [100, 0, 600], [130, 0, 1000]);
		expect(release(slowRight, at(130, 0, 1400), WIDTH)).toEqual({
			kind: 'snooze',
			direction: 1,
			dx: 130
		});
		const slowLeft = path([-15, 0, 100], [-130, 0, 1000]);
		expect(release(slowLeft, at(-130, 0, 1400), WIDTH)).toMatchObject({
			kind: 'snooze',
			direction: -1
		});
	});

	it('springs back from a short slow drag', () => {
		const short = path([15, 0, 100], [60, 0, 600]);
		expect(release(short, at(60, 0, 900), WIDTH)).toEqual({ kind: 'stay' });
	});

	it('snoozes a short fast flick, but not a tiny one', () => {
		const flick = path([15, 0, 10], [60, 0, 60]);
		expect(release(flick, at(70, 0, 70), WIDTH)).toMatchObject({ kind: 'snooze', direction: 1 });
		const tiny = path([12, 0, 5], [FLICK_MIN - 5, 0, 15]);
		expect(release(tiny, at(FLICK_MIN - 5, 0, 20), WIDTH)).toEqual({ kind: 'stay' });
	});

	it('keeps a card flicked back toward where it was, however far it went', () => {
		const back = path([15, 0, 100], [200, 0, 800], [140, 0, 850]);
		expect(release(back, at(130, 0, 860), WIDTH)).toEqual({ kind: 'stay' });
		// The same place, held still before letting go: it goes.
		expect(release(back, at(130, 0, 1200), WIDTH)).toMatchObject({ kind: 'snooze' });
	});

	it('needs no more than MAX_DISTANCE on a wide card', () => {
		const drag = path([15, 0, 100], [MAX_DISTANCE, 0, 2000]);
		expect(release(drag, at(MAX_DISTANCE, 0, 2400), 1200)).toMatchObject({ kind: 'snooze' });
		expect(release(drag, at(MAX_DISTANCE, 0, 2400), WIDTH)).toMatchObject({ kind: 'snooze' });
		const short = path([15, 0, 100], [MAX_DISTANCE - 10, 0, 2000]);
		expect(release(short, at(MAX_DISTANCE - 10, 0, 2400), 1200)).toEqual({ kind: 'stay' });
	});

	it('never snoozes from a tap, a scroll, or a gesture the browser took over', () => {
		expect(release(path([3, 2, 50]), at(3, 2, 60), WIDTH)).toEqual({ kind: 'stay' });
		expect(release(path([0, 200, 100]), at(200, 200, 120), WIDTH)).toEqual({ kind: 'stay' });
		expect(release(path([15, 0, 10], [200, 0, 60]), null, WIDTH)).toEqual({ kind: 'stay' });
	});
});

describe('speed', () => {
	it('is measured over the last 100 ms only', () => {
		const g = path([15, 0, 10], [200, 0, 300], [210, 0, 500]);
		if (g.phase !== 'dragging') throw new Error('expected a drag');
		expect(g.trail.map((p) => p.t)).toEqual([500]);
		expect(speed(g.trail)).toBe(0);
		expect(speed([at(0, 0, 0), at(100, 0, 100)])).toBe(1);
		expect(speed([at(0, 0, 0), at(-50, 0, 100)])).toBe(-0.5);
		expect(speed([])).toBe(0);
	});
});
