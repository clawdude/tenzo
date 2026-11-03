import type { QueueItem } from '@tenzo/client-runtime';
import { renderMarkdown } from './markdown.ts';

/**
 * A reply card's content (the mock-up's replies/2): what you asked, then the agent's final words.
 * When those open with a heading, it is the card's headline, as a question's ask is; the rest
 * is the body, as markdown.
 */
export interface ReplyView {
	/** Your prompt, as the daemon kept it; empty when Tenzo sent none. */
	asked: string;
	/** The heading the agent's words open with, as plain text; null when they open otherwise. */
	headline: string | null;
	/** The rest of what it said, rendered (escaped and limited by markdown.ts). */
	bodyHtml: string;
}

export function replyView(item: QueueItem): ReplyView | null {
	if (item.kind !== 'reply' || !item.reply) return null;
	const lines = item.reply.message.replaceAll('\r\n', '\n').split('\n');
	const first = lines.findIndex((line) => line.trim() !== '');
	const heading = first === -1 ? null : /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(lines[first] ?? '');
	const headline = heading?.[1]?.replaceAll(/\*\*|__|`/g, '').trim() || null;
	const body = headline ? lines.slice(first + 1).join('\n') : item.reply.message;
	return { asked: item.reply.prompt.trim(), headline, bodyHtml: renderMarkdown(body.trim()) };
}
