import { describe, expect, it } from 'vitest';
import { blurLeaves, editsInCard, foldedLine, TAP_MS } from './editor.ts';

describe('the card as an editor', () => {
	it('opens on a touch screen, never with a mouse or trackpad', () => {
		expect(editsInCard(false)).toBe(true);
		expect(editsInCard(true)).toBe(false);
	});

	it('stays open when the focus moves within the card, or the card was just tapped', () => {
		expect(blurLeaves(true, Infinity)).toBe(false);
		expect(blurLeaves(false, 40)).toBe(false); // Cancel, mic or ⌄ on iOS: the field just blurs
		expect(blurLeaves(false, TAP_MS - 1)).toBe(false);
	});

	it('closes when the keyboard goes or something outside the card is tapped', () => {
		expect(blurLeaves(false, Infinity)).toBe(true); // nothing tapped in the card yet
		expect(blurLeaves(false, TAP_MS + 200)).toBe(true);
		expect(blurLeaves(false, -5)).toBe(true); // a clock that went back proves nothing
	});

	it('keeps one line of what is being answered', () => {
		expect(foldedLine(null, 'Which database?')).toBe('Which database?');
		expect(foldedLine('Why is the\ncheckout test flaky?', 'It races')).toBe(
			'You asked: Why is the checkout test flaky?'
		);
		expect(foldedLine('  ', 'It races the timer')).toBe('It races the timer');
		expect(foldedLine(undefined, 'Two\n\n  lines')).toBe('Two lines');
	});
});
