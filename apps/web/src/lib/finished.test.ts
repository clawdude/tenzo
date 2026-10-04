import { describe, expect, it } from 'vitest';
import { finished, item } from './fixtures.ts';
import { finishedView } from './finished.ts';

describe('finishedView', () => {
	it('has the headline, the rendered note, a badge per check, the screenshots and the live link', () => {
		const card = finished('f');
		expect(finishedView(card, 'Add a counter')).toEqual({
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
			live: `/live/${card.threadId}/counter`
		});
	});

	it("falls back to the thread's title, and leaves out what the agent didn't give", () => {
		const card = finished('f', {
			headline: undefined,
			howToTest: ' ',
			attachments: [],
			live: null,
			checks: []
		});
		expect(finishedView(card, 'Add a counter')).toMatchObject({
			headline: 'Add a counter',
			howToTestHtml: '',
			badges: [],
			shots: [],
			live: null
		});
	});

	it('is nothing for other cards', () => {
		expect(finishedView(item('q'), 'T')).toBeNull();
	});

	it('renders what the agent wrote as text, never as markup', () => {
		const card = finished('f', {
			summary: '<img src=x onerror=alert(1)>',
			howToTest: '[x](javascript:alert(1))'
		});
		const view = finishedView(card, 'T');
		expect(view?.summaryHtml).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>');
		expect(view?.howToTestHtml).toBe('<p>x</p>');
	});
});
