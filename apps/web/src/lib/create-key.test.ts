import { describe, expect, it } from 'vitest';
import { keyFor, randomKey } from './create-key.ts';

describe('keyFor', () => {
	let n = 0;
	const make = () => `key-${++n}`;

	it('keeps the key while the same words go to the same project, so a retry reuses it', () => {
		const first = keyFor(null, 'Add a dark mode', 'prj_a', make);
		expect(keyFor(first, 'Add a dark mode', 'prj_a', make)).toBe(first);
	});

	it('makes a new key for changed words or another project: a different request', () => {
		const first = keyFor(null, 'Add a dark mode', 'prj_a', make);
		expect(keyFor(first, 'Add a light mode', 'prj_a', make).key).not.toBe(first.key);
		expect(keyFor(first, 'Add a dark mode', 'prj_b', make).key).not.toBe(first.key);
	});
});

describe('randomKey', () => {
	it('is 32 hex characters, different each time, and fits the command', () => {
		const a = randomKey();
		expect(a).toMatch(/^[0-9a-f]{32}$/);
		expect(randomKey()).not.toBe(a);
	});
});
