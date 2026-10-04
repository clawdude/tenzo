import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '@tenzo/client-runtime';
import { overrideLabel, runningModel, setModelCommand } from './model.ts';

describe("the thread's ⋯: its own model", () => {
	it("says what the thread chose, or that its project's config decides", () => {
		expect(overrideLabel({ model: null, thinking: null })).toBe('Project default');
		expect(overrideLabel({ model: 'opus', thinking: null })).toBe('opus');
		expect(overrideLabel({ model: 'opus', thinking: 'high' })).toBe('opus · thinking high');
		expect(overrideLabel({ model: null, thinking: 'off' })).toBe('thinking off');
	});

	it('sends a blank model as null: back to the project default', () => {
		expect(setModelCommand('thr_1', '  ', null)).toEqual({
			type: 'thread.setModel',
			threadId: 'thr_1',
			model: null,
			thinking: null
		});
		expect(setModelCommand('thr_1', ' sonnet ', 'low')).toEqual({
			type: 'thread.setModel',
			threadId: 'thr_1',
			model: 'sonnet',
			thinking: 'low'
		});
	});

	it("reads what the session runs on from its latest session.configured", () => {
		const configured = (seq: number, model: string) =>
			({ seq, event: { type: 'session.configured', payload: { model } } }) as unknown as StoredEvent;
		const other = { seq: 3, event: { type: 'turn.started', payload: {} } } as unknown as StoredEvent;
		expect(runningModel([])).toBeNull();
		expect(runningModel([configured(1, 'claude-haiku-4-5'), configured(2, 'sonnet'), other])).toBe('sonnet');
	});
});
