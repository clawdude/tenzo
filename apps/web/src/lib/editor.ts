/**
 * The card as an editor (#72). On a touch screen, focusing the answer field turns the Pass card
 * into a writing space: what is being answered folds to one line, the field takes the rest of
 * the card, and Cancel and Send sit under it. The Pass already fits itself to what the keyboard
 * leaves visible (viewport.ts), so the card is exactly the space above the keyboard.
 */

/** How long after a tap in the card the field losing focus is still that tap's doing. */
export const TAP_MS = 600;

/** Edit in the card itself: everywhere but with a mouse or trackpad, where the field stays inline. */
export function editsInCard(finePointer: boolean): boolean {
	return !finePointer;
}

/**
 * Whether the field losing focus puts the card back. Not when the focus went elsewhere in the
 * card, or the card was just tapped: iOS doesn't focus a tapped button, the field just blurs.
 * Anything else (the keyboard dismissed, a tap outside) does.
 */
export function blurLeaves(focusInCard: boolean, sinceTap: number): boolean {
	if (focusInCard) return false;
	return !(sinceTap >= 0 && sinceTap < TAP_MS);
}

/**
 * The one line kept of what is being answered while the card is folded: on a reply, what you
 * asked; otherwise the question. On one line, however many it had.
 */
export function foldedLine(asked: string | null | undefined, ask: string): string {
	const line = asked?.trim() ? `You asked: ${asked}` : ask;
	return line.replaceAll(/\s+/g, ' ').trim();
}
