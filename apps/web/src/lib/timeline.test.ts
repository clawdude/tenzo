import { describe, expect, it } from 'vitest';
import { question, said, stored, tool, TURN } from './fixtures.ts';
import {
	clip,
	clockOf,
	heldEvents,
	ROW_PAGE,
	type Row,
	runTitle,
	sessionOf,
	timelineOf,
	type ToolCall,
	windowOf
} from './timeline.ts';

const REQ = 'req_aaaaaaaaaaaaaaaaaaaa';
const kinds = (rows: Row[]) => rows.map((r) => r.kind);

describe('timelineOf', () => {
	it('reads a thread: your prompt, what it said, its tools folded into one row, its question and your answer', () => {
		const rows = timelineOf([
			stored(1, { type: 'session.started', turnId: undefined, payload: { sessionId: 's', resumed: false } }),
			stored(2, { type: 'turn.started', payload: { prompt: 'Add dark mode' } }),
			stored(3, {
				type: 'item.completed',
				itemId: TURN,
				payload: { itemType: 'user_message', status: 'completed', text: 'Add dark mode' }
			}),
			tool(4, 't1', 'started', { text: 'Read: /w/app.ts', toolKind: 'file_read', toolName: 'Read' }),
			tool(5, 't2', 'started', { text: 'Read: /w/theme.ts', toolKind: 'file_read', toolName: 'Read' }),
			tool(6, 't1', 'completed', { text: 'Read: /w/app.ts', toolKind: 'file_read', toolName: 'Read', output: 'export {}' }),
			tool(7, 't3', 'started', { text: 'Bash: npm test', toolKind: 'command', toolName: 'Bash' }),
			tool(8, 't2', 'completed', { text: 'Read: /w/theme.ts', toolKind: 'file_read', toolName: 'Read', status: 'failed' }),
			said(9, 'Two ways to do this.'),
			tool(10, 'ask', 'started', { text: 'AskUserQuestion: Which?', toolKind: 'tool', toolName: 'AskUserQuestion' }),
			stored(11, {
				type: 'user-input.requested',
				requestId: REQ,
				payload: { questions: [question('Which theme?', ['Dark', 'Light'])] }
			}),
			stored(12, { type: 'user-input.resolved', requestId: REQ, payload: { answers: { 'Which theme?': 'Dark' }, cancelled: false } })
		]);
		expect(kinds(rows)).toEqual(['prompt', 'tools', 'said', 'question']);
		expect(rows[0]).toMatchObject({ text: 'Add dark mode' }); // once, not twice
		const tools = rows[1];
		if (tools?.kind !== 'tools') throw new Error('not tools');
		expect(tools.title).toBe('Read 2 files · Ran a command');
		expect(tools.running).toBe(true); // npm test hasn't finished
		expect(tools.failed).toBe(1);
		expect(tools.calls.map((c) => [c.summary, c.status, c.output])).toEqual([
			['Read: /w/app.ts', 'completed', 'export {}'],
			['Read: /w/theme.ts', 'failed', null],
			['Bash: npm test', 'in_progress', null]
		]);
		expect(rows[3]).toMatchObject({ ask: 'Which theme?', answer: 'Dark' });
	});

	it("keeps each row's key as the thread goes on, so the view doesn't redraw them", () => {
		const start = [tool(1, 't1', 'started', { text: 'Bash: ls', toolKind: 'command', toolName: 'Bash' })];
		const later = [...start, tool(2, 't1', 'completed', { text: 'Bash: ls', toolKind: 'command', toolName: 'Bash', output: 'a' }), said(3, 'Done.')];
		expect(timelineOf(start).map((r) => r.key)).toEqual(['tools:t1']);
		expect(timelineOf(later).map((r) => r.key)).toEqual(['tools:t1', 'said:m3']);
	});

	it("counts a subagent's steps on its call and keeps its words inside", () => {
		const rows = timelineOf([
			tool(1, 'sub', 'started', { text: 'Agent: map auth', toolKind: 'subagent', toolName: 'Agent' }),
			tool(2, 'c1', 'started', { text: 'Read: a', toolKind: 'file_read', toolName: 'Read', parentItemId: 'sub' }),
			said(3, 'inner chatter', 'sub'),
			tool(4, 'c2', 'started', { text: 'Grep: x', toolKind: 'file_read', toolName: 'Grep', parentItemId: 'sub' }),
			tool(5, 'sub', 'completed', { text: 'Agent: map auth', toolKind: 'subagent', toolName: 'Agent', output: 'Found it' })
		]);
		expect(rows).toHaveLength(1);
		const tools = rows[0];
		if (tools?.kind !== 'tools') throw new Error('not tools');
		expect(tools.title).toBe('Agent: map auth');
		expect(tools.calls[0]).toMatchObject({ steps: 2, output: 'Found it', status: 'completed' });
	});

	it('shows permissions, proposals, reports and what went wrong, with your answers', () => {
		const rows = timelineOf([
			stored(1, {
				type: 'request.opened',
				requestId: 'req_bbbbbbbbbbbbbbbbbbbb',
				payload: { toolKind: 'command', toolName: 'Bash', detail: 'Bash: rm -rf build', input: {} }
			}),
			stored(2, { type: 'request.resolved', requestId: 'req_bbbbbbbbbbbbbbbbbbbb', payload: { decision: 'deny', message: 'not that' } }),
			stored(3, {
				type: 'proposal.requested',
				requestId: 'req_cccccccccccccccccccc',
				payload: { headline: 'Dark mode', summary: 'A toggle.' }
			}),
			stored(4, { type: 'proposal.resolved', requestId: 'req_cccccccccccccccccccc', payload: { decision: 'change', note: 'smaller' } }),
			stored(5, {
				type: 'report.submitted',
				requestId: 'req_dddddddddddddddddddd',
				payload: { summary: 'Added it.', howToTest: '', checks: [{ name: 'Tests', status: 'pass' }] }
			}),
			stored(6, { type: 'runtime.error', payload: { message: 'Rate limited' } }),
			stored(7, { type: 'turn.completed', payload: { state: 'failed', errorMessage: 'Rate limited' } }),
			stored(8, { type: 'turn.completed', turnId: '22222222-2222-4222-8222-222222222222', payload: { state: 'interrupted' } }),
			stored(9, { type: 'session.exited', payload: { exitKind: 'error', reason: 'boom' } }),
			stored(10, { type: 'thread.archived', turnId: undefined, payload: {} })
		]);
		expect(rows.map((r) => [r.kind, 'answer' in r ? r.answer : 'text' in r ? r.text : ''])).toEqual([
			['permission', 'Denied: not that'],
			['proposal', 'Change: smaller'],
			['report', null],
			['note', 'Rate limited'], // once: the failed turn says the same
			['note', 'Stopped'],
			['note', 'The agent stopped: boom'],
			['note', 'Archived']
		]);
		expect(rows[2]).toMatchObject({ headline: 'Ready for review', checks: [{ name: 'Tests' }] });
	});

	it("shows paths in the thread's worktree relative to it", () => {
		const rows = timelineOf(
			[
				tool(1, 't1', 'started', { text: 'Read: /home/wt/thr_1/src/a.ts', toolKind: 'file_read', toolName: 'Read' }),
				tool(2, 't2', 'started', { text: 'Bash: ls /home/wt/thr_1x /etc', toolKind: 'command', toolName: 'Bash' })
			],
			'/home/wt/thr_1/'
		);
		const tools = rows[0];
		if (tools?.kind !== 'tools') throw new Error('not tools');
		expect(tools.calls.map((c) => c.summary)).toEqual(['Read: src/a.ts', 'Bash: ls /home/wt/thr_1x /etc']);
	});

	it("reads landing: Merge or Open PR, the ready PR and your answer, wakes, landed, stuck", () => {
		const rows = timelineOf([
			stored(1, { type: 'report.submitted', requestId: 'req_dddddddddddddddddddd', payload: { summary: 'Done.', howToTest: '', checks: [] } }),
			stored(2, { type: 'report.resolved', requestId: 'req_dddddddddddddddddddd', payload: { decision: 'pr' } }),
			stored(3, { type: 'wake.scheduled', payload: { at: new Date(2026, 9, 4, 15, 30).toISOString(), why: 'CI' } }),
			stored(4, { type: 'wake.fired', payload: { why: 'CI' } }),
			stored(5, {
				type: 'merge.ready',
				requestId: 'req_eeeeeeeeeeeeeeeeeeee',
				payload: { url: 'https://github.com/o/r/pull/3', summary: 'Green, approved.' }
			}),
			stored(6, { type: 'merge.resolved', requestId: 'req_eeeeeeeeeeeeeeeeeeee', payload: { decision: 'merge' } }),
			stored(7, { type: 'landing.stuck', payload: { cause: 'unarchived', message: 'Work left over', prompts: [] } }),
			stored(8, { type: 'thread.landed', payload: { url: 'https://github.com/o/r/pull/3', summary: 'Merged.' } })
		]);
		expect(rows.map((r) => [r.kind, 'answer' in r ? r.answer : 'text' in r ? r.text : ''])).toEqual([
			['report', 'Open PR'],
			['note', 'Landing: it opens the PR and sees it through review; you merge'],
			['note', 'Asked to be woken at 15:30: CI'],
			['note', 'Woke up: CI'],
			['ready', 'Merge'],
			['note', 'Landing: it opens the PR, sees it through CI and review, and merges'],
			['note', 'Work left over'],
			['landed', '']
		]);
		expect(rows[4]).toMatchObject({ url: 'https://github.com/o/r/pull/3', summary: 'Green, approved.' });
		expect(rows[6]).toMatchObject({ tone: 'fail' });
		expect(rows[7]).toMatchObject({ summary: 'Merged.' });
	});

	it('links a thread it started, by the id start_thread answered with', () => {
		const call = { toolKind: 'mcp', toolName: 'mcp__tenzo__start_thread' };
		const rows = timelineOf([
			tool(1, 's1', 'started', { ...call, input: { prompt: 'Fix the docs\nin full', title: 'Docs' } }),
			tool(2, 's1', 'completed', {
				...call,
				output: 'Started thr_bbbbbbbbbbbbbbbbbbbb ("Fix the docs") in app, on tenzo/fix-the-docs. It talks to the person on its own.'
			}),
			tool(3, 's2', 'started', { ...call, input: { prompt: 'Another' } }),
			tool(4, 's2', 'completed', { ...call, status: 'failed', output: 'A thread can start 3 at most.' })
		]);
		expect(rows).toMatchObject([
			{ kind: 'started', childId: 'thr_bbbbbbbbbbbbbbbbbbbb', title: 'Fix the docs', failed: false },
			{ kind: 'started', childId: null, title: 'Another', failed: true, detail: 'A thread can start 3 at most.' }
		]);
	});

	it('takes a prompt from its user message when the turn carried none', () => {
		const rows = timelineOf([
			stored(1, {
				type: 'item.completed',
				itemId: 'u1',
				payload: { itemType: 'user_message', status: 'completed', text: 'Hello' }
			})
		]);
		expect(rows).toMatchObject([{ kind: 'prompt', text: 'Hello' }]);
	});
});

describe('runTitle', () => {
	const call = (toolKind: ToolCall['toolKind'], summary = 's'): ToolCall => ({
		key: summary,
		summary,
		toolKind,
		status: 'completed',
		output: null,
		steps: 0
	});
	it('names one call by itself, several by kind, most first', () => {
		expect(runTitle([call('command', 'Bash: ls')])).toBe('Bash: ls');
		expect(runTitle([call('file_read'), call('command'), call('file_read')])).toBe('Read 2 files · Ran a command');
		expect(runTitle([call('file_read'), call('file_read'), call('command'), call('web'), call('mcp')])).toBe(
			'Read 2 files · Ran a command · 2 more'
		);
	});
});

describe('clip', () => {
	it('leaves short text whole', () => {
		expect(clip('one\ntwo', { chars: 100, lines: 5 })).toEqual({ head: 'one\ntwo', more: false });
	});
	it('cuts by lines, then by characters at a word end', () => {
		expect(clip('a\nb\nc\nd', { chars: 100, lines: 2 })).toEqual({ head: 'a\nb', more: true });
		expect(clip('alpha beta gamma delta', { chars: 13, lines: 5 })).toEqual({ head: 'alpha beta', more: true });
		expect(clip('x'.repeat(30), { chars: 10, lines: 5 })).toEqual({ head: 'x'.repeat(10), more: true });
	});
});

describe('windowOf', () => {
	it('draws only the last rows of a long thread, a page more at a time', () => {
		const rows = Array.from({ length: 1000 }, (_, i) => i);
		const first = windowOf(rows, ROW_PAGE);
		expect(first.shown).toHaveLength(ROW_PAGE);
		expect(first.shown[0]).toBe(1000 - ROW_PAGE);
		expect(first.hidden).toBe(1000 - ROW_PAGE);
		expect(windowOf(rows, 2000)).toEqual({ shown: rows, hidden: 0 });
	});
});

describe('heldEvents', () => {
	const range = (from: number, to: number) =>
		Array.from({ length: to - from + 1 }, (_, i) => said(from + i, `line ${from + i}`));
	const seqs = (events: readonly { seq: number }[]) => events.map((e) => e.seq);

	it('draws the feed as it is at the end', () => {
		const latest = range(5, 9);
		expect(heldEvents(range(1, 4), latest, true)).toEqual({ events: latest, newer: 0 });
		expect(heldEvents([], latest, false)).toEqual({ events: latest, newer: 0 });
	});

	it("reading further up at the feed's cap, nothing drawn moves: dropped events stay, new ones wait", () => {
		// The feed is full: as 3 new events arrive, its 3 oldest go.
		const shown = range(1, 10);
		const latest = range(4, 13);
		const held = heldEvents(shown, latest, false);
		expect(held.events).toBe(shown);
		expect(held.newer).toBe(3);
		// Rows from the held events are the same rows, with the same keys, in the same order.
		expect(timelineOf(held.events).map((r) => r.key)).toEqual(timelineOf(shown).map((r) => r.key));
		// Back at the end, the feed is drawn as it is.
		expect(seqs(heldEvents(held.events, latest, true).events)).toEqual(seqs(latest));
	});

	it('lets older pages you asked for join in front while you read', () => {
		const shown = range(10, 12);
		const held = heldEvents(shown, [...range(7, 9), ...range(10, 14)], false);
		expect(seqs(held.events)).toEqual([7, 8, 9, 10, 11, 12]);
		expect(held.newer).toBe(2);
	});
});

describe('sessionOf', () => {
	it("is the latest session's id", () => {
		const start = (seq: number, sessionId: string) =>
			stored(seq, { type: 'session.started', payload: { sessionId, resumed: false } });
		expect(sessionOf([start(1, 'a'), said(2, 'hi'), start(3, 'b')])).toBe('b');
		expect(sessionOf([said(1, 'hi')])).toBeNull();
	});
});

describe('clockOf', () => {
	it('says the time of day', () => {
		const at = new Date(2026, 9, 3, 9, 5).toISOString();
		expect(clockOf(at)).toBe('09:05');
		expect(clockOf('nonsense')).toBe('');
	});
});
