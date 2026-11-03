import { describe, expect, it } from 'vitest';
import { entersSend } from './textarea.ts';

const key = (k: string, extra: Partial<KeyboardEvent> = {}) => ({
	key: k,
	shiftKey: false,
	altKey: false,
	isComposing: false,
	...extra
});

describe('the answer field', () => {
	it('sends on Enter with a hardware keyboard; Shift+Enter is a new line', () => {
		expect(entersSend(key('Enter'), true)).toBe(true);
		expect(entersSend(key('Enter', { shiftKey: true }), true)).toBe(false);
		expect(entersSend(key('Enter', { altKey: true }), true)).toBe(false);
		expect(entersSend(key('a'), true)).toBe(false);
	});

	it('on a phone Enter is a new line, and a word being composed is never sent', () => {
		expect(entersSend(key('Enter'), false)).toBe(false);
		expect(entersSend(key('Enter', { isComposing: true }), true)).toBe(false);
	});
});
