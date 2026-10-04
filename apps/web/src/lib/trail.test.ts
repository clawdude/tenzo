import { describe, expect, it } from 'vitest';
import { canGoBack, EMPTY_TRAIL, follow, type Step, stepsBackTo, type Trail } from './trail.ts';

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
