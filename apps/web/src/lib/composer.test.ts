import { describe, expect, it } from 'vitest';
import { archiveSheet, refusedForChanges } from './archive.ts';
import { asShown, footOf, placeholderOf, stillWaiting, takesMessages } from './composer.ts';
import { failure, item, reply, stored, thread } from './fixtures.ts';
import { replyView } from './reply.ts';

const t = thread('a');
const started = (seq: number, prompt: string) => stored(seq, { type: 'turn.started', payload: { prompt } });

describe('the thread page message field', () => {
	it('shows while nothing is open but a reply, and never for an archived thread', () => {
		expect(takesMessages(t, [])).toBe(true);
		expect(footOf(t, [])).toBe('field');
		// A reply's answer can come from here too: the message is it.
		expect(footOf(t, [{ ...reply('r'), threadId: t.id }])).toBe('field');
		// A question, an error: the answer belongs on its card.
		expect(footOf(t, [{ ...item('q'), threadId: t.id }])).toBe('pass');
		expect(footOf(t, [{ ...failure('e'), threadId: t.id }])).toBe('pass');
		const snoozed = { ...item('q'), threadId: t.id, snoozedUntil: '2026-10-03T11:00:00.000Z' };
		expect(footOf(t, [snoozed])).toBe('none');
		// Another thread's item is no reason.
		expect(footOf(t, [{ ...item('q'), threadId: 'thr_bbbbbbbbbbbbbbbbbbbb' }])).toBe('field');
		expect(footOf({ ...t, status: 'archived' }, [])).toBe('none');
		expect(footOf(undefined, [])).toBe('none');
	});

	it("reads an archive from the thread's log: the watch's copy is from before", () => {
		const archived = stored(20, { type: 'thread.archived', payload: { reason: 'manual' } });
		expect(asShown(t, [])).toBe(t);
		expect(asShown({ ...t, working: true }, [archived])).toMatchObject({ status: 'archived', working: false });
		expect(footOf(asShown(t, [archived]), [])).toBe('none');
		expect(asShown(null, [archived])).toBeUndefined();
	});

	it('says a message waits its turn while the thread works', () => {
		expect(placeholderOf(t)).toBe('Message…');
		expect(placeholderOf({ ...t, working: true })).toBe('Message… (waits its turn)');
	});

	it('keeps each message sent here until a later turn starts with it', () => {
		const working = { ...t, working: true, queued: 2 };
		const pending = [
			{ text: 'Also the README', after: 10 },
			{ text: 'And the tests', after: 10 }
		];
		expect(stillWaiting(pending, [started(8, 'Also the README')], working)).toEqual(pending);
		expect(stillWaiting(pending, [started(11, 'Also the README')], working)).toEqual([pending[1]]);
		// The same words twice wait for two turns.
		const twice = [
			{ text: 'go', after: 10 },
			{ text: 'go', after: 10 }
		];
		expect(stillWaiting(twice, [started(11, 'go')], working)).toHaveLength(1);
		// Nothing running and nothing queued: none waits any more (it ran, or was dropped).
		expect(stillWaiting(pending, [], { ...t, working: false, queued: 0 })).toEqual([]);
		expect(stillWaiting(pending, [], { ...working, status: 'archived' })).toEqual([]);
	});
});

describe('the archive sheet', () => {
	it('just asks with a clean worktree; warns and forces with uncommitted files', () => {
		expect(archiveSheet(0)).toEqual({ warning: null, confirm: 'Archive', force: false });
		expect(archiveSheet(null)).toEqual({ warning: null, confirm: 'Archive', force: false });
		expect(archiveSheet(1)).toEqual({
			warning: "1 file has changes that aren't committed. It'll be lost.",
			confirm: 'Archive anyway',
			force: true
		});
		expect(archiveSheet(2).warning).toBe("2 files have changes that aren't committed. They'll be lost.");
	});

	it("knows the daemon's refusal for changes that came after the count", () => {
		expect(refusedForChanges('/x has uncommitted changes. Commit them to tenzo/x, or archive with --force')).toBe(true);
		expect(refusedForChanges('thr_x is archived.')).toBe(false);
	});
});

describe('the reply card', () => {
	it('shows what you asked, the heading it opens with as the headline, the rest as markdown', () => {
		expect(replyView(reply('r'))).toEqual({
			asked: 'Why is the checkout test flaky?',
			headline: "It races the payment mock's timer",
			bodyHtml: '<p><code>checkout.test.ts</code> waits 50 ms.</p>'
		});
		const plain = replyView(reply('r', 'Yes: **src/pay.ts**.', ''));
		expect(plain).toEqual({ asked: '', headline: null, bodyHtml: '<p>Yes: <strong>src/pay.ts</strong>.</p>' });
		expect(replyView(item('q'))).toBeNull();
	});
});
