import { describe, expect, it } from 'vitest';
import { project } from './fixtures.ts';
import { chooseProject, LAST_PROJECT_KEY, rememberedProject, rememberProject } from './projects.ts';

function memory() {
	const data = new Map<string, string>();
	return {
		data,
		getItem: (key: string) => data.get(key) ?? null,
		setItem: (key: string, value: string) => void data.set(key, value)
	};
}

describe('chooseProject', () => {
	const app = project('app');
	const blog = project('blog');

	it('picks the one used last while it still exists, else the first', () => {
		expect(chooseProject([app, blog], blog.id)).toBe(blog);
		expect(chooseProject([app, blog], null)).toBe(app);
		expect(chooseProject([app], blog.id)).toBe(app); // blog was removed
		expect(chooseProject([], blog.id)).toBeNull();
	});
});

describe('remembering the last project', () => {
	it('round-trips through storage', () => {
		const store = memory();
		expect(rememberedProject(store)).toBeNull();
		rememberProject('prj_bbbbbbbbbbbbbbbbbbbb', store);
		expect(store.data.get(LAST_PROJECT_KEY)).toBe('prj_bbbbbbbbbbbbbbbbbbbb');
		expect(rememberedProject(store)).toBe('prj_bbbbbbbbbbbbbbbbbbbb');
	});

	it('shrugs when storage is missing or refuses', () => {
		const refusing = {
			getItem: () => {
				throw new Error('SecurityError');
			},
			setItem: () => {
				throw new Error('QuotaExceededError');
			}
		};
		expect(rememberedProject(refusing)).toBeNull();
		expect(() => rememberProject('prj_x', refusing)).not.toThrow();
		expect(rememberedProject(null)).toBeNull();
	});
});
