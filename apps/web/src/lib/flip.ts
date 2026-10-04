/**
 * Turning a card over (More, and Back): it turns away edge-on, its other side is swapped in,
 * and it turns back to face you. Quick, and only the card moves. With reduced motion the sides
 * just swap.
 */

const HALF_MS = 150;
const PERSPECTIVE = 'perspective(1400px)';

/** The person asked for less motion. */
function still(): boolean {
	return (
		typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
	);
}

/**
 * Turns `card` over: `swap` changes its content when it is edge-on (and may return a promise for
 * the content to be drawn). `toBack` sets which way it turns.
 */
export async function turnOver(
	card: HTMLElement | null,
	toBack: boolean,
	swap: () => void | Promise<void>
): Promise<void> {
	if (!card || still() || typeof card.animate !== 'function') {
		await swap();
		return;
	}
	const away = toBack ? -90 : 90;
	// Held edge-on (`fill`) while the other side is drawn, so it never flashes back.
	const out = card.animate(
		[{ transform: `${PERSPECTIVE} rotateY(0deg)` }, { transform: `${PERSPECTIVE} rotateY(${away}deg)` }],
		{ duration: HALF_MS, easing: 'cubic-bezier(.4,0,1,1)', fill: 'forwards' }
	);
	await out.finished.catch(() => {});
	await swap();
	const back = card.animate(
		[{ transform: `${PERSPECTIVE} rotateY(${-away}deg)` }, { transform: `${PERSPECTIVE} rotateY(0deg)` }],
		{ duration: HALF_MS + 40, easing: 'cubic-bezier(0,0,.2,1)' }
	);
	out.cancel();
	await back.finished.catch(() => {});
}
