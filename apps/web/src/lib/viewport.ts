/**
 * Keeping the card's field and buttons on screen while a phone's keyboard is up.
 *
 * iOS doesn't shrink the layout viewport for the keyboard: it pans the page and leaves a fixed
 * layout partly under the keyboard. The visual viewport says what is actually visible, so while
 * the person types, the Pass is sized and placed to exactly that, and made compact (no header,
 * no room for the pile) so the card keeps the space. After the keyboard goes, iOS can leave the
 * page panned; scrolling back to the top undoes that.
 */

export interface Visible {
	/** The visual viewport's height and its offset from the layout viewport's top, in px. */
	height: number;
	offsetTop: number;
}

/** Where the Pass goes: `null` means the whole window, as usual. */
export interface Fit {
	height: number;
	top: number;
	/** Little room: drop the header and the pile's margin, keep the card. */
	compact: boolean;
}

/** A keyboard takes at least this much off the window. */
const KEYBOARD_PX = 80;
/** Below this, the Pass is compact while typing even without a keyboard (a short window). */
const SHORT_PX = 560;

export function fitTo(visible: Visible | null, windowHeight: number, typing: boolean): Fit | null {
	if (!visible || !typing) return null;
	const keyboard = windowHeight - visible.height > KEYBOARD_PX;
	if (!keyboard && visible.height >= SHORT_PX) return null;
	return {
		height: Math.round(visible.height),
		top: Math.round(visible.offsetTop),
		compact: true
	};
}

/** Is this element one the keyboard comes up for? */
export function isTyping(element: Element | null): boolean {
	if (!element) return false;
	if (element instanceof HTMLTextAreaElement) return true;
	return element instanceof HTMLInputElement && !['button', 'submit', 'checkbox', 'radio'].includes(element.type);
}

/**
 * Calls `onFit` whenever what is visible or the focus changes, with where the Pass should go.
 * Returns a stop function.
 */
export function watchViewport(onFit: (fit: Fit | null) => void): () => void {
	const vv = window.visualViewport;
	const update = () => {
		const visible = vv ? { height: vv.height, offsetTop: vv.offsetTop } : null;
		onFit(fitTo(visible, window.innerHeight, isTyping(document.activeElement)));
	};
	const onFocusOut = () => {
		// Focus may be moving to another field; look once it has landed.
		setTimeout(() => {
			update();
			if (!isTyping(document.activeElement)) window.scrollTo(0, 0);
		}, 0);
	};
	vv?.addEventListener('resize', update);
	vv?.addEventListener('scroll', update);
	document.addEventListener('focusin', update);
	document.addEventListener('focusout', onFocusOut);
	update();
	return () => {
		vv?.removeEventListener('resize', update);
		vv?.removeEventListener('scroll', update);
		document.removeEventListener('focusin', update);
		document.removeEventListener('focusout', onFocusOut);
	};
}
