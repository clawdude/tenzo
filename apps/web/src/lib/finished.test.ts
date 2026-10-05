import { describe, expect, it } from 'vitest';
import { finished, item } from './fixtures.ts';
import { finishedView } from './finished.ts';

describe('finishedView', () => {
	it('has the headline, the rendered note, a badge per check, the screenshots and the live link', () => {
		const card = finished('f');
		expect(finishedView(card, 'Add a counter', 'https://mac.ts.net:8444')).toEqual({
			headline: 'Counter works',
			summaryHtml: '<p>Added a <strong>counter</strong> page.</p>',
			howToTestHtml: '<p>Open it and tap <code>+</code>.</p>',
			badges: [
				{ label: 'Tests', status: 'pass', detail: '3 passed' },
				{ label: 'Lint failed', status: 'fail', detail: 'unused import' },
				{ label: 'E2E skipped', status: 'skipped', detail: '' }
			],
			shots: [
				{
					url: `/api/attachments/${card.threadId}/att_aaaaaaaaaaaaaaaaaaaa.png`,
					alt: 'The counter',
					caption: 'The counter'
				}
			],
			live: `https://mac.ts.net:8444/live/${card.threadId}/counter`
		});
	});

	it("goes through the live origin's door with a paired device's grant", () => {
		const card = finished('f');
		const live = finishedView(card, 'T', 'https://mac.ts.net:8444', 'dev_x.1.sig')?.live;
		expect(live).toBe(
			`https://mac.ts.net:8444/_tenzo/live?grant=dev_x.1.sig&to=${encodeURIComponent(`/live/${card.threadId}/counter`)}`
		);
	});

	it('has no live link when the daemon publishes no live origin', () => {
		expect(finishedView(finished('f'), 'T', null)?.live).toBeNull();
	});

	it("falls back to the thread's title, and leaves out what the agent didn't give", () => {
		const card = finished('f', {
			headline: undefined,
			howToTest: ' ',
			attachments: [],
			live: null,
			checks: []
		});
		expect(finishedView(card, 'Add a counter', 'http://127.0.0.1:4781')).toMatchObject({
			headline: 'Add a counter',
			howToTestHtml: '',
			badges: [],
			shots: [],
			live: null
		});
	});

	it('is nothing for other cards', () => {
		expect(finishedView(item('q'), 'T', null)).toBeNull();
	});

	it('renders what the agent wrote as text, never as markup', () => {
		const card = finished('f', {
			summary: '<img src=x onerror=alert(1)>',
			howToTest: '[x](javascript:alert(1))'
		});
		const view = finishedView(card, 'T', null);
		expect(view?.summaryHtml).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
		expect(view?.howToTestHtml).toBe('<p>x</p>');
	});
});
