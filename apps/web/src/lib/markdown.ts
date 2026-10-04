/**
 * A small, safe Markdown renderer for what agents write on cards: proposal summaries, handoff
 * notes, how to test. It knows paragraphs, lists, headings (shown as a bold line), fenced code,
 * inline code, bold, italic and links, and nothing else.
 *
 * Safe by construction: every character of the input reaches the output escaped, as text. The
 * only markup is what this file writes itself, and the only attribute that carries input is a
 * link's `href`, which must be http(s), mailto or a same-origin path. Raw HTML in the input is
 * shown, not run. The result is meant for `{@html}`.
 */

export function renderMarkdown(source: string): string {
	const lines = source.replaceAll('\r\n', '\n').split('\n');
	const out: string[] = [];
	let paragraph: string[] = [];
	let list: { ordered: boolean; items: string[] } | null = null;

	const flushParagraph = () => {
		if (paragraph.length > 0) out.push(`<p>${paragraph.map(inline).join('<br>')}</p>`);
		paragraph = [];
	};
	const flushList = () => {
		if (!list) return;
		const tag = list.ordered ? 'ol' : 'ul';
		out.push(`<${tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${tag}>`);
		list = null;
	};
	const flush = () => {
		flushParagraph();
		flushList();
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? '';
		const fence = /^\s*(`{3,}|~{3,})/.exec(line);
		if (fence) {
			flush();
			const close = fence[1] ?? '```';
			const code: string[] = [];
			for (i++; i < lines.length && !(lines[i] ?? '').trim().startsWith(close); i++) {
				code.push(lines[i] ?? '');
			}
			out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
			continue;
		}
		if (line.trim() === '') {
			flush();
			continue;
		}
		const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
		if (heading) {
			flush();
			out.push(`<p><strong>${inline(heading[1] ?? '')}</strong></p>`);
			continue;
		}
		const item = /^\s*([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
		if (item) {
			flushParagraph();
			const ordered = /\d/.test(item[1] ?? '');
			if (list && list.ordered !== ordered) flushList();
			list ??= { ordered, items: [] };
			list.items.push(item[2] ?? '');
			continue;
		}
		const text = line.replace(/^\s*>\s?/, '').trim();
		if (list && /^\s/.test(line)) {
			// An indented line under a list item continues it.
			const last = list.items.length - 1;
			list.items[last] = `${list.items[last]} ${text}`;
			continue;
		}
		flushList();
		paragraph.push(text);
	}
	flush();
	return out.join('');
}

/** Characters that begin something inline; anything between them is plain text. */
const PLAIN = /^[^`[*_\\h]+/;

/** One line (or list item) of inline Markdown. */
function inline(text: string): string {
	let out = '';
	let i = 0;
	while (i < text.length) {
		const rest = text.slice(i);
		const before = i > 0 ? (text[i - 1] ?? '') : '';
		let m: RegExpExecArray | null;
		if ((m = PLAIN.exec(rest))) {
			out += escapeHtml(m[0]);
		} else if ((m = /^\\([\\`*_[\]()#+\-.!>])/.exec(rest))) {
			out += escapeHtml(m[1] ?? '');
		} else if ((m = /^(`+)([\s\S]*?[^`])\1(?!`)/.exec(rest))) {
			out += `<code>${escapeHtml((m[2] ?? '').trim())}</code>`;
		} else if ((m = /^\[([^\]]+)\]\(\s*((?:[^()\s]|\([^()\s]*\))+)\s*\)/.exec(rest))) {
			const href = safeHref(m[2] ?? '');
			out += href ? link(href, inline(m[1] ?? '')) : inline(m[1] ?? '');
		} else if (
			!/\w/.test(before) &&
			(m = /^https?:\/\/[^\s<>"'`]*[^\s<>"'`.,;:!?)\]]/.exec(rest)) &&
			safeHref(m[0])
		) {
			out += link(m[0], escapeHtml(m[0]));
		} else if ((m = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest))) {
			out += `<strong>${inline(m[2] ?? '')}</strong>`;
		} else if ((m = /^\*(?=[^\s*])([^*]*?[^\s*])\*/.exec(rest))) {
			out += `<em>${inline(m[1] ?? '')}</em>`;
		} else if (!/\w/.test(before) && (m = /^_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/.exec(rest))) {
			out += `<em>${inline(m[1] ?? '')}</em>`;
		} else {
			m = null;
			out += escapeHtml(text[i] ?? '');
		}
		i += m ? m[0].length : 1;
	}
	return out;
}

function link(href: string, content: string): string {
	return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${content}</a>`;
}

/**
 * A link target that can only navigate: http(s) and mailto URLs, or a path on this origin. Never
 * `javascript:`, `data:` or a protocol-relative `//host`.
 */
export function safeHref(raw: string): string | null {
	const href = raw.trim();
	if (href.startsWith('/') && !href.startsWith('//') && !href.startsWith('/\\')) return href;
	if (!/^(https?:\/\/|mailto:)/i.test(href)) return null;
	try {
		const url = new URL(href);
		return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? href : null;
	} catch {
		return null;
	}
}

export function escapeHtml(text: string): string {
	return text
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#39;');
}
