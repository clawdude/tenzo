import { attachmentUrl, type CheckStatus, liveUrl, type QueueItem } from '@tenzo/client-runtime';
import { renderMarkdown } from './markdown.ts';

/**
 * What the finished card shows (PRODUCT.md §6), worked out from the item so it can be tested:
 * the headline, the handoff note, a badge per check, the screenshots and the live link.
 */

export interface Badge {
	label: string;
	status: CheckStatus;
	/** The agent's detail, for the badge's title. */
	detail: string;
}

export interface Shot {
	url: string;
	alt: string;
	caption: string;
}

export interface FinishedView {
	/** The agent's headline, else the thread's title. */
	headline: string;
	/** The handoff note, rendered (markdown.ts). */
	summaryHtml: string;
	/** How to try it, rendered; empty when the agent gave none. */
	howToTestHtml: string;
	badges: Badge[];
	shots: Shot[];
	/** The "Open live" link, on the daemon's origin; null when nothing was exposed. */
	live: string | null;
}

export function finishedView(item: QueueItem, threadTitle: string): FinishedView | null {
	const f = item.finished;
	if (item.kind !== 'finished' || !f) return null;
	return {
		headline: f.headline || threadTitle || item.ask,
		summaryHtml: renderMarkdown(f.summary),
		howToTestHtml: f.howToTest.trim() ? renderMarkdown(f.howToTest) : '',
		badges: f.checks.map((c) => ({
			label: c.status === 'pass' ? c.name : `${c.name} ${c.status === 'fail' ? 'failed' : 'skipped'}`,
			status: c.status,
			detail: c.detail ?? ''
		})),
		shots: f.attachments.map((a) => ({
			url: attachmentUrl(item.threadId, a),
			alt: a.caption || a.name,
			caption: a.caption ?? ''
		})),
		live: f.live ? liveUrl(item.threadId, f.live) : null
	};
}
