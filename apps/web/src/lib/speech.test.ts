import { afterEach, describe, expect, it, vi } from 'vitest';

/** A browser recognizer the test drives by hand. */
class FakeRecognition {
	static last: FakeRecognition | null = null;
	lang = '';
	interimResults = false;
	continuous = false;
	onresult: ((event: { results: { transcript: string }[][] }) => void) | null = null;
	onend: (() => void) | null = null;
	onerror: ((event: { error?: string }) => void) | null = null;
	started = false;
	constructor() {
		FakeRecognition.last = this;
	}
	start() {
		this.started = true;
	}
	stop() {
		this.onend?.();
	}
}

const scope = globalThis as { webkitSpeechRecognition?: unknown };

async function fresh() {
	// The module remembers a refusal for the session: each test gets a new session.
	vi.resetModules();
	return import('./speech.ts');
}

afterEach(() => {
	delete scope.webkitSpeechRecognition;
});

describe('dictation', () => {
	it('has no mic where the browser has no speech recognition', async () => {
		const speech = await fresh();
		expect(speech.canDictate()).toBe(false);
		expect(speech.dictate(() => {}, () => {})).toBeNull();
	});

	it('hands over the transcript so far, and ends once', async () => {
		scope.webkitSpeechRecognition = FakeRecognition;
		const speech = await fresh();
		expect(speech.canDictate()).toBe(true);
		const heard: string[] = [];
		let ended = 0;
		const stop = speech.dictate((t) => heard.push(t), () => ended++);
		const r = FakeRecognition.last!;
		expect(r.started).toBe(true);
		r.onresult?.({ results: [[{ transcript: 'use the' }]] });
		r.onresult?.({ results: [[{ transcript: 'use the' }], [{ transcript: ' test db' }]] });
		stop?.();
		r.onerror?.({ error: 'aborted' });
		expect(heard).toEqual(['use the', 'use the test db']);
		expect(ended).toBe(1);
		expect(speech.canDictate()).toBe(true); // a hiccup, not a refusal
	});

	it('hides the mic for the session once listening is not allowed', async () => {
		scope.webkitSpeechRecognition = FakeRecognition;
		const speech = await fresh();
		let ended = 0;
		speech.dictate(() => {}, () => ended++);
		FakeRecognition.last!.onerror?.({ error: 'service-not-allowed' });
		expect(ended).toBe(1);
		expect(speech.canDictate()).toBe(false);
		expect(speech.isRefusal('not-allowed')).toBe(true);
		expect(speech.isRefusal('no-speech')).toBe(false);
	});
});
