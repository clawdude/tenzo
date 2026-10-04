import { describe, expect, it } from 'vitest';
import {
	canGoBack,
	EMPTY_TRAIL,
	follow,
	loadTrail,
	resume,
	saveTrail,
	type Step,
	stepsBackTo,
	TRAIL_KEY,
	type Trail
} from './trail.ts';

const at = (path: string) => ({ url: new URL(`http://tenzo.test${path}`) });
const enter = (path: string): Step => ({ type: 'enter', to: at(path) });
const link = (path: string): Step => ({ type: 'link', to: at(path) });
const pop = (path: string, delta: number): Step => ({ type: 'popstate', to: at(path), delta });

function walk(...steps: (Step | [Step, 'replace'])[]): Trail {
	return steps.reduce<Trail>(
		(trail, step) =>
			Array.isArray(step) ? follow(trail, step[0], true) : follow(trail, step),
		EMPTY_TRAIL
	);
}

describe('follow', () => {
	it('starts on a direct load without reading `from`, which SvelteKit gives as { url: null }', () => {
		// The first navigation of a direct load of /threads: `from` is there, its url is null.
		const first = { type: 'enter', from: { url: null }, to: at('/threads') } as Step;
		expect(follow(EMPTY_TRAIL, first)).toEqual({ paths: ['/threads'], index: 0 });
	});

	it('counts links forward, back gestures back, and replacements in place', () => {
		const trail = walk(enter('/'), link('/threads'), link('/new'));
		expect(trail).toEqual({ paths: ['/', '/threads', '/new'], index: 2 });
		expect(follow(trail, pop('/threads', -1))).toEqual({ paths: trail.paths, index: 1 });
		expect(follow(trail, link('/'), true)).toEqual({ paths: ['/', '/threads', '/'], index: 2 });
	});

	it('starts afresh when the browser goes somewhere it never saw', () => {
		const trail = walk(enter('/new'));
		expect(follow(trail, pop('/', -1))).toEqual({ paths: ['/'], index: 0 });
	});

	it('ignores a navigation that leaves the app', () => {
		const trail = walk(enter('/'));
		expect(follow(trail, { type: 'leave', to: null })).toBe(trail);
	});
});

describe('leaving a screen', () => {
	it('goes back to the Pass past Threads after New was opened from Threads', () => {
		const trail = walk(enter('/'), link('/threads'), link('/new'));
		expect(stepsBackTo(trail, '/')).toBe(-2);
		expect(canGoBack(trail)).toBe(true);
	});

	it('has nothing to go back to on a direct load: the screen is replaced instead', () => {
		for (const path of ['/new', '/threads']) {
			const trail = walk(enter(path));
			expect(stepsBackTo(trail, '/')).toBeNull();
			expect(canGoBack(trail)).toBe(false);
		}
		const replaced = walk(enter('/threads'), [link('/'), 'replace']);
		expect(replaced).toEqual({ paths: ['/'], index: 0 });
	});
});

describe('after a reload', () => {
	const saved = walk(enter('/'), link('/threads'), link('/new'));

	it('carries on from the saved trail, so Close goes back instead of stacking a Pass', () => {
		const trail = resume(saved, enter('/new'), 'reload');
		expect(trail).toBe(saved);
		expect(stepsBackTo(trail, '/')).toBe(-2);
	});

	it('carries on when the history brings the tab back to where it was', () => {
		const left = follow(saved, pop('/threads', -1));
		expect(resume(left, enter('/threads'), 'back_forward')).toBe(left);
	});

	it('starts afresh on a fresh load, on another path, or with nothing saved', () => {
		const fresh = { paths: ['/new'], index: 0 };
		expect(resume(saved, enter('/new'), 'navigate')).toEqual(fresh);
		expect(resume(saved, enter('/threads'), 'reload')).toEqual({ paths: ['/threads'], index: 0 });
		expect(resume(null, enter('/new'), 'reload')).toEqual(fresh);
	});
});

describe('the saved trail', () => {
	function memory() {
		const data = new Map<string, string>();
		return {
			getItem: (key: string) => data.get(key) ?? null,
			setItem: (key: string, value: string) => void data.set(key, value)
		};
	}

	it('round-trips through the tab storage', () => {
		const store = memory();
		const trail = walk(enter('/'), link('/new'));
		saveTrail(store, trail);
		expect(loadTrail(store)).toEqual(trail);
	});

	it('is null when there is none, storage throws, or what is there is not a trail', () => {
		const store = memory();
		expect(loadTrail(store)).toBeNull();
		expect(loadTrail(null)).toBeNull();
		const blocked = {
			getItem: (): string | null => {
				throw new Error('SecurityError');
			},
			setItem: () => {
				throw new Error('QuotaExceededError');
			}
		};
		expect(loadTrail(blocked)).toBeNull();
		expect(() => saveTrail(blocked, EMPTY_TRAIL)).not.toThrow();
		for (const junk of [
			'not json',
			'null',
			'{"paths":["/"],"index":1}',
			'{"paths":["/"],"index":-1}',
			'{"paths":[3],"index":0}',
			'{"paths":["https://evil.example/"],"index":0}',
			'{"paths":"/","index":0}'
		]) {
			store.setItem(TRAIL_KEY, junk);
			expect(loadTrail(store), junk).toBeNull();
		}
	});
});
