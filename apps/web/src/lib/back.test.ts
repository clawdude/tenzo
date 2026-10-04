import type { QueueItem, ThreadDiff } from '@tenzo/client-runtime';
import { describe, expect, it } from 'vitest';
import {
	backLabels,
	changeView,
	errorOf,
	filesOf,
	FILES_LIMIT,
	reasoningOf,
	REASONING_LIMIT,
	relativeTo,
	weighedOf,
	whyBack
} from './back.ts';
import { finished, item, permission, proposal, question, said, stored, tool } from './fixtures.ts';

const ask = (seq: number, requestId: string) =>
	stored(seq, {
		type: 'user-input.requested',
		requestId,
		payload: { questions: [question('Which color?', ['Red', 'Blue'], 'Blue')] }
	});

describe('backLabels', () => {
	it('gives every kind of card a back, and says what is on it', () => {
		expect(backLabels(item('a'))).toEqual({ kind: 'why', pill: "Why it's asking", title: "Why it's asking" });
		expect(backLabels(permission('a'))).toMatchObject({ kind: 'why', pill: 'What exactly' });
		expect(backLabels(proposal('a'))).toMatchObject({ kind: 'why', pill: 'What it looked at' });
		expect(backLabels(finished('a'))).toMatchObject({ kind: 'change', pill: 'See the change', title: 'The change' });
		const error = { ...item('a'), kind: 'error' } as unknown as QueueItem;
		expect(backLabels(error)).toMatchObject({ kind: 'error', title: 'What went wrong' });
		const unknown = { ...item('a'), kind: 'something-new' } as unknown as QueueItem;
		expect(backLabels(unknown)).toMatchObject({ kind: 'why' });
	});
});

describe('reasoningOf', () => {
	const card = item('a', { context: 'From the card' });
	it("is what it said in the asking turn before it asked, not a subagent's words or later ones", () => {
		const events = [
			said(1, 'Earlier turn.'),
			said(2, 'The store keeps tokens.'),
			said(3, 'inner', 'sub'),
			said(4, 'Three ways to go.'),
			ask(5, card.requestId),
			said(6, 'After the ask.')
		];
		events[0] = stored(1, {
			...events[0]?.event,
			turnId: '22222222-2222-4222-8222-222222222222'
		});
		expect(reasoningOf(card, events)).toBe('The store keeps tokens.\n\nThree ways to go.');
	});
	it("falls back to the card's context, and keeps the end of a long one", () => {
		expect(reasoningOf(card, [])).toBe('From the card');
		const long = 'x'.repeat(REASONING_LIMIT) + ' the end';
		const text = reasoningOf(card, [said(1, long), ask(2, card.requestId)]);
		expect(text.startsWith('…')).toBe(true);
		expect(text.endsWith('the end')).toBe(true);
		expect(text.length).toBeLessThanOrEqual(REASONING_LIMIT + 1);
	});
});

describe('weighedOf', () => {
	it("lists each option with what it means, the card's suggestion marked", () => {
		expect(weighedOf(item('a'))).toEqual([
			{
				question: '',
				choices: [
					{ label: 'Red', description: 'Why Red', suggested: false },
					{ label: 'Blue', description: 'Why Blue', suggested: true }
				]
			}
		]);
		const two = item('b', { questions: [question('Q1?', ['A'], 'A'), question('Q2?', ['B', 'C'], 'C')] });
		expect(weighedOf(two).map((w) => [w.question, w.choices.filter((c) => c.suggested).map((c) => c.label)])).toEqual([
			['Q1?', ['A']],
			['Q2?', ['C']]
		]);
		expect(weighedOf(permission('a'))).toEqual([]);
	});
});

describe('filesOf', () => {
	const edit = (seq: number, path: string) =>
		tool(seq, `e${seq}`, 'started', { toolKind: 'file_change', toolName: 'Edit', input: { file_path: path } });
	const read = (seq: number, path: string) =>
		tool(seq, `r${seq}`, 'started', { toolKind: 'file_read', toolName: 'Read', input: { file_path: path } });
	it('lists what it changed and what it only read, relative to the worktree', () => {
		const files = filesOf(
			[
				read(1, '/w/auth/store.ts'),
				read(2, '/w/auth/refresh.ts'),
				edit(3, '/w/auth/store.ts'),
				read(4, '/w/auth/store.ts'),
				tool(5, 'g', 'started', { toolKind: 'file_read', toolName: 'Grep', input: { pattern: 'x' } }),
				read(6, '/elsewhere/notes.md'),
				read(7, `/w/${'x'.repeat(300)}… (40 more characters)`)
			],
			'/w'
		);
		expect(files).toEqual({
			changed: ['auth/store.ts'],
			read: ['auth/refresh.ts', '/elsewhere/notes.md'],
			moreChanged: 0,
			moreRead: 0
		});
	});
	it('keeps the latest few', () => {
		const events = Array.from({ length: FILES_LIMIT + 3 }, (_, i) => edit(i + 1, `/w/f${i}.ts`));
		const files = filesOf(events, '/w/');
		expect(files.changed).toHaveLength(FILES_LIMIT);
		expect(files.changed.at(-1)).toBe(`f${FILES_LIMIT + 2}.ts`);
		expect(files.moreChanged).toBe(3);
	});
	it('relativizes only paths inside the worktree', () => {
		expect(relativeTo('/w/a.ts', '/w')).toBe('a.ts');
		expect(relativeTo('/wx/a.ts', '/w')).toBe('/wx/a.ts');
	});
});

describe('whyBack', () => {
	it('puts the three together', () => {
		const card = item('a');
		const back = whyBack(card, [said(1, 'Because.'), ask(2, card.requestId)], '/w');
		expect(back.reasoning).toBe('Because.');
		expect(back.weighed).toHaveLength(1);
		expect(back.files.changed).toEqual([]);
	});
});

describe('changeView', () => {
	const diff = (files: ThreadDiff['files'], extra: Partial<ThreadDiff> = {}): ThreadDiff => ({
		base: 'main',
		files,
		fileCount: files.length,
		added: files.reduce((s, f) => s + (f.added ?? 0), 0),
		deleted: files.reduce((s, f) => s + (f.deleted ?? 0), 0),
		truncated: false,
		...extra
	});
	it('says the change in a line, then each file with its +/−', () => {
		const view = changeView(
			diff([
				{ path: 'lib/theme.ts', status: 'untracked', added: 41, deleted: 0 },
				{ path: 'app.html', status: 'modified', added: 6, deleted: 4 },
				{ path: 'old.ts', status: 'deleted', added: 0, deleted: 9 },
				{ path: 'new.ts', from: 'was.ts', status: 'renamed', added: 0, deleted: 0 },
				{ path: 'logo.png', status: 'added', added: null, deleted: null }
			])
		);
		expect(view.headline).toBe('5 files · +47 −13');
		expect(view.lines).toEqual([
			{ path: 'lib/theme.ts', added: '+41', deleted: '', note: 'new' },
			{ path: 'app.html', added: '+6', deleted: '−4', note: '' },
			{ path: 'old.ts', added: '', deleted: '−9', note: 'deleted' },
			{ path: 'new.ts', added: '', deleted: '', note: 'from was.ts' },
			{ path: 'logo.png', added: '', deleted: '', note: 'new · binary' }
		]);
		expect(view.more).toBe('');
	});
	it('says when there is nothing, and when only some files are listed', () => {
		expect(changeView(diff([])).headline).toBe('No changes yet');
		const some = changeView(
			diff([{ path: 'a', status: 'modified', added: 1, deleted: 0 }], { fileCount: 14, added: 90, truncated: true })
		);
		expect(some.headline).toBe('14 files · +90');
		expect(some.more).toBe('And 13 more files');
	});
});

describe('errorOf', () => {
	it("is an error card's message, else its ask", () => {
		const error = { ...item('a'), kind: 'error', ask: 'The turn failed', error: { message: 'Rate limited', cause: 'turn', prompts: [] } };
		expect(errorOf(error as unknown as QueueItem)).toBe('Rate limited');
		expect(errorOf(item('a'))).toBe('Which color?');
	});
});
