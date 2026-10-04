import { describe, expect, it } from 'vitest';
import { fitTo } from './viewport.ts';

describe('fitTo', () => {
	it('leaves the Pass alone when nobody is typing', () => {
		expect(fitTo({ height: 400, offsetTop: 0 }, 844, false)).toBeNull();
		expect(fitTo(null, 844, true)).toBeNull(); // no visual viewport to go by
	});

	it('fits the Pass to what the keyboard leaves visible, compact', () => {
		// iPhone: the window stays 844 tall, the keyboard leaves 508, and iOS panned 120 down.
		expect(fitTo({ height: 508.4, offsetTop: 120.2 }, 844, true)).toEqual({
			height: 508,
			top: 120,
			compact: true
		});
	});

	it('needs nothing while typing in a tall window with no keyboard (a desktop)', () => {
		expect(fitTo({ height: 860, offsetTop: 0 }, 860, true)).toBeNull();
	});

	it('goes compact in a short window, keyboard or not', () => {
		expect(fitTo({ height: 450, offsetTop: 0 }, 450, true)).toEqual({
			height: 450,
			top: 0,
			compact: true
		});
	});
});
