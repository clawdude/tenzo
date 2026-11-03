/**
 * The answer and message fields: a textarea that grows with its text, up to a few lines (its CSS
 * max-height), then scrolls. On a phone Enter is a new line and the send button sends; with a
 * hardware keyboard (a fine pointer) Enter sends and Shift+Enter is a new line.
 */

/** Whether this Enter sends the form rather than adding a line. */
export function entersSend(
	event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'isComposing'>,
	finePointer: boolean
): boolean {
	return finePointer && event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.isComposing;
}

function finePointer(): boolean {
	return typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
}

/** The keydown handler: Enter submits the field's form where a hardware keyboard is. */
export function onEnter(event: KeyboardEvent): void {
	if (!entersSend(event, finePointer())) return;
	event.preventDefault();
	const form = (event.currentTarget as HTMLTextAreaElement).form;
	form?.requestSubmit();
}

/**
 * A Svelte action: the textarea's height follows its text. The parameter is the text, so a value
 * set from code (dictation, a cleared field) resizes it too; past its max-height it scrolls.
 */
export function autogrow(node: HTMLTextAreaElement, _text: string) {
	const fit = () => {
		node.style.height = 'auto';
		node.style.height = `${node.scrollHeight}px`;
	};
	fit();
	node.addEventListener('input', fit);
	return {
		update: fit,
		destroy: () => node.removeEventListener('input', fit)
	};
}
