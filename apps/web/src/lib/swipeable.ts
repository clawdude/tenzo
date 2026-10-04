import type { Action } from 'svelte/action';
import { begin, type Gesture, move, type Point, release } from './swipe.ts';

/**
 * Lets a card be swiped aside, with pointer events: touch on a phone, a mouse on a desktop. The
 * element should have `touch-action: pan-y`, so the browser still scrolls the card's text up and
 * down itself (and cancels the gesture when it does) while sideways moves come here.
 *
 * Gestures that start on something you tap or type in (a button, the answer field, a link) are
 * left alone: a drag that ends over the suggested button must never answer it.
 */
export interface SwipeOptions {
	/** Off: the card stays put (offline, say). */
	enabled: boolean;
	/** The card follows the finger: `dx` px from where it sits. */
	ondrag: (dx: number) => void;
	/** Let go short of a swipe, or the browser took over: the card goes back. */
	onsettle: () => void;
	/** Swiped: `direction` -1 left, 1 right, from `dx` px. */
	onswipe: (direction: -1 | 1, dx: number) => void;
}

const INTERACTIVE = 'button, a, input, textarea, select, label, [contenteditable], [role="button"]';

export const swipeable: Action<HTMLElement, SwipeOptions> = (node, initial) => {
	let options = initial;
	let gesture: Gesture | null = null;
	let pointer: number | null = null;

	const at = (event: PointerEvent): Point => ({
		x: event.clientX,
		y: event.clientY,
		t: event.timeStamp
	});

	function down(event: PointerEvent) {
		if (!options.enabled || pointer !== null || !event.isPrimary) return;
		if (event.pointerType === 'mouse' && event.button !== 0) return;
		if (event.target instanceof Element && event.target.closest(INTERACTIVE)) return;
		// Nothing is prevented here: text stays selectable (an error's message, to copy it) until
		// the gesture has turned out to be a sideways drag.
		gesture = begin(at(event));
		pointer = event.pointerId;
	}

	function moved(event: PointerEvent) {
		if (event.pointerId !== pointer || gesture === null) return;
		const before = gesture.phase;
		gesture = move(gesture, at(event));
		if (gesture.phase === 'scrolling') {
			reset();
			return;
		}
		if (gesture.phase !== 'dragging') return;
		if (before !== 'dragging') {
			try {
				node.setPointerCapture(event.pointerId);
			} catch {
				// The pointer is gone already; pointercancel follows.
			}
			// A mouse may have started selecting text on the way: the drag wins.
			getSelection()?.removeAllRanges();
		}
		event.preventDefault();
		options.ondrag(gesture.dx);
	}

	function up(event: PointerEvent) {
		if (event.pointerId !== pointer || gesture === null) return;
		const dragging = gesture.phase === 'dragging';
		const result = release(gesture, at(event), node.getBoundingClientRect().width);
		reset();
		if (result.kind === 'snooze') options.onswipe(result.direction, result.dx);
		else if (dragging) options.onsettle();
	}

	function cancel(event: PointerEvent) {
		if (event.pointerId !== pointer) return;
		const dragging = gesture?.phase === 'dragging';
		reset();
		if (dragging) options.onsettle();
	}

	function reset() {
		gesture = null;
		pointer = null;
	}

	/** No text selection while the card is being dragged. */
	function select(event: Event) {
		if (gesture?.phase === 'dragging') event.preventDefault();
	}

	node.addEventListener('selectstart', select);
	node.addEventListener('pointerdown', down);
	node.addEventListener('pointermove', moved);
	node.addEventListener('pointerup', up);
	node.addEventListener('pointercancel', cancel);
	return {
		update(next) {
			options = next;
			if (!next.enabled && gesture?.phase === 'dragging') {
				reset();
				next.onsettle();
			}
		},
		destroy() {
			node.removeEventListener('selectstart', select);
			node.removeEventListener('pointerdown', down);
			node.removeEventListener('pointermove', moved);
			node.removeEventListener('pointerup', up);
			node.removeEventListener('pointercancel', cancel);
		}
	};
};
