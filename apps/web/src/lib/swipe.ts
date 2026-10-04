/**
 * Swiping a card aside to snooze it, as a pure function of pointer positions: the card component
 * feeds it pointer events (swipeable.ts) and draws what it says. Kept free of the DOM so the
 * thresholds can be tested.
 *
 * A gesture starts `pending`. Once the finger has moved `SLOP` px it picks an axis for good:
 * clearly sideways is a drag (the card follows the finger), anything else is the card's text
 * scrolling, and the gesture lets go so the browser can scroll. On release a drag snoozes when it
 * went far enough, or was flicked fast enough the same way; otherwise the card springs back.
 */

/** Movement (px) before the gesture picks an axis: a tap's wobble is not a swipe. */
export const SLOP = 10;
/** How much more sideways than up or down a move must be to drag the card, not scroll it. */
export const AXIS_RATIO = 1.2;
/** Released past this share of the card's width, the card goes… */
export const DISTANCE_SHARE = 0.35;
/** …or past this many px, whichever is less (a wide card on a desktop). */
export const MAX_DISTANCE = 140;
/** A flick this fast (px/ms) the same way sends it from a shorter drag… */
export const FLICK_SPEED = 0.5;
/** …of at least this many px. */
export const FLICK_MIN = 40;
/** Speed is measured over the last this many ms. */
export const SPEED_WINDOW = 100;

/** A pointer position and when it was there (ms, any monotonic clock). */
export interface Point {
	x: number;
	y: number;
	t: number;
}

export type Gesture =
	| { phase: 'pending'; start: Point }
	/** `dx`: how far the card is from where it was; `trail`: the recent points, for speed. */
	| { phase: 'dragging'; start: Point; dx: number; trail: readonly Point[] }
	/** Not ours: the text scrolls. Stays so until the finger lifts. */
	| { phase: 'scrolling' };

export type Release =
	| { kind: 'snooze'; direction: -1 | 1; dx: number }
	| { kind: 'stay' };

export function begin(point: Point): Gesture {
	return { phase: 'pending', start: point };
}

export function move(gesture: Gesture, point: Point): Gesture {
	switch (gesture.phase) {
		case 'scrolling':
			return gesture;
		case 'pending': {
			const dx = point.x - gesture.start.x;
			const dy = point.y - gesture.start.y;
			if (Math.max(Math.abs(dx), Math.abs(dy)) < SLOP) return gesture;
			if (Math.abs(dx) < Math.abs(dy) * AXIS_RATIO) return { phase: 'scrolling' };
			return { phase: 'dragging', start: gesture.start, dx, trail: [gesture.start, point] };
		}
		case 'dragging':
			return {
				...gesture,
				dx: point.x - gesture.start.x,
				trail: [...gesture.trail.filter((p) => point.t - p.t <= SPEED_WINDOW), point]
			};
	}
}

/** Sideways speed over the trail, px/ms; negative is leftwards. */
export function speed(trail: readonly Point[]): number {
	const first = trail[0];
	const last = trail.at(-1);
	if (!first || !last || last.t <= first.t) return 0;
	return (last.x - first.x) / (last.t - first.t);
}

/**
 * What lifting the finger at `point` (null: the browser took the gesture) does to a card `width`
 * px wide. Only a drag can snooze. A long drag snoozes unless it was being flicked back; a short
 * one snoozes when flicked the same way.
 */
export function release(gesture: Gesture, point: Point | null, width: number): Release {
	if (gesture.phase !== 'dragging' || point === null) return { kind: 'stay' };
	const last = move(gesture, point);
	if (last.phase !== 'dragging') return { kind: 'stay' };
	const { dx } = last;
	if (dx === 0) return { kind: 'stay' };
	const direction = dx < 0 ? -1 : 1;
	const v = speed(last.trail);
	const flick = Math.abs(v) >= FLICK_SPEED ? Math.sign(v) : 0;
	const far = Math.abs(dx) >= Math.min(width * DISTANCE_SHARE, MAX_DISTANCE);
	const snooze =
		(far && flick !== -direction) || (flick === direction && Math.abs(dx) >= FLICK_MIN);
	return snooze ? { kind: 'snooze', direction, dx } : { kind: 'stay' };
}
