import { describe, expect, it } from 'vitest';
import { renderMarkdown as md, safeHref } from './markdown.ts';

describe('renderMarkdown: what it renders', () => {
	it('paragraphs, with single line breaks kept', () => {
		expect(md('One line\nnext line.\n\nSecond paragraph.')).toBe(
			'<p>One line<br>next line.</p><p>Second paragraph.</p>'
		);
	});

	it('bullet and numbered lists, continuation lines included', () => {
		expect(md('- one\n- two\n  more\n\n1. first\n2) second')).toBe(
			'<ul><li>one</li><li>two more</li></ul><ol><li>first</li><li>second</li></ol>'
		);
		expect(md('Intro:\n* a\n+ b\nAfter.')).toBe(
			'<p>Intro:</p><ul><li>a</li><li>b</li></ul><p>After.</p>'
		);
	});

	it('headings as a bold line', () => {
		expect(md('## Plan\nDo it.')).toBe('<p><strong>Plan</strong></p><p>Do it.</p>');
	});

	it('inline code, bold, italic', () => {
		expect(md('Run `pnpm test` **now**, *please*, _really_ __twice__.')).toBe(
			'<p>Run <code>pnpm test</code> <strong>now</strong>, <em>please</em>, <em>really</em> <strong>twice</strong>.</p>'
		);
	});

	it('leaves snake_case, lone stars and arithmetic alone', () => {
		expect(md('use snake_case_names and 2 * 3 * 4')).toBe(
			'<p>use snake_case_names and 2 * 3 * 4</p>'
		);
	});

	it('fenced code blocks, verbatim', () => {
		expect(md('Try:\n```sh\npnpm dev\n  --port 5173\n```\nDone.')).toBe(
			'<p>Try:</p><pre><code>pnpm dev\n  --port 5173</code></pre><p>Done.</p>'
		);
	});

	it('links, and bare URLs, opening outside the app', () => {
		expect(md('See [the docs](https://example.com/a?b=1&c=2).')).toBe(
			'<p>See <a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">the docs</a>.</p>'
		);
		expect(md('Open https://example.com/x, then /live/thr_x/.')).toBe(
			'<p>Open <a href="https://example.com/x" target="_blank" rel="noopener noreferrer">https://example.com/x</a>, then /live/thr_x/.</p>'
		);
		expect(md('[app](/live/thr_x/)')).toContain('href="/live/thr_x/"');
		expect(md('[w](https://w.example/Foo_(bar)).')).toBe(
			'<p><a href="https://w.example/Foo_(bar)" target="_blank" rel="noopener noreferrer">w</a>.</p>'
		);
	});

	it('backslash escapes', () => {
		expect(md('\\*not italic\\*')).toBe('<p>*not italic*</p>');
	});
});

describe('renderMarkdown: nothing in the input runs', () => {
	const cases: [string, string][] = [
		['<script>alert(1)</script>', '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>'],
		['<img src=x onerror=alert(1)>', '<p>&lt;img src=x onerror=alert(1)&gt;</p>'],
		['**<b onclick="x">bold</b>**', '<p><strong>&lt;b onclick=&quot;x&quot;&gt;bold&lt;/b&gt;</strong></p>'],
		['`</code><script>x</script>`', '<p><code>&lt;/code&gt;&lt;script&gt;x&lt;/script&gt;</code></p>'],
		['```\n</code></pre><script>x</script>\n```', '<pre><code>&lt;/code&gt;&lt;/pre&gt;&lt;script&gt;x&lt;/script&gt;</code></pre>'],
		['- <iframe src="javascript:x">', '<ul><li>&lt;iframe src=&quot;javascript:x&quot;&gt;</li></ul>'],
		['## <svg onload=alert(1)>', '<p><strong>&lt;svg onload=alert(1)&gt;</strong></p>'],
		["it's & \"quoted\"", '<p>it&#39;s &amp; &quot;quoted&quot;</p>']
	];
	for (const [input, output] of cases) {
		it(`escapes ${JSON.stringify(input)}`, () => {
			expect(md(input)).toBe(output);
		});
	}

	it('drops links that could run script or leave the origin unannounced, keeping their text', () => {
		for (const href of [
			'javascript:alert(1)',
			'JaVaScRiPt:alert(1)',
			'%6Aavascript:alert(1)',
			'javascript&#58;alert(1)',
			'data:text/html,<script>alert(1)</script>',
			'vbscript:msgbox(1)',
			'file:///etc/passwd',
			'//evil.example/x',
			'/\\evil.example'
		]) {
			const html = md(`[click](${href})`);
			expect(html, href).not.toContain('<a');
			expect(html, href).toContain('click');
		}
	});

	it('keeps an attribute closed whatever the URL holds', () => {
		const html = md('[x](https://a.example/"onmouseover="alert(1))');
		expect(html).not.toMatch(/"\s*onmouseover=/);
		expect(html).toContain('&quot;onmouseover=&quot;');
		expect(md('https://a.example/<script>')).toBe(
			'<p><a href="https://a.example/" target="_blank" rel="noopener noreferrer">https://a.example/</a>&lt;script&gt;</p>'
		);
	});

	it('emits only its own tags', () => {
		const html = md(
			'# T\n<div>x</div>\n- *a* `b` [c](https://c.example) **d**\n```\n<p>\n```\n<a href="x">y</a>'
		);
		const tags = [...html.matchAll(/<\/?([a-z0-9]+)/g)].map((m) => m[1]);
		for (const tag of tags) {
			expect(['p', 'strong', 'em', 'code', 'pre', 'ul', 'ol', 'li', 'a', 'br']).toContain(tag);
		}
		expect(html.match(/<a /g)).toHaveLength(1);
	});
});

describe('safeHref', () => {
	it('takes http(s), mailto and same-origin paths only', () => {
		expect(safeHref('https://x.example')).toBe('https://x.example');
		expect(safeHref(' http://x.example ')).toBe('http://x.example');
		expect(safeHref('mailto:a@b.example')).toBe('mailto:a@b.example');
		expect(safeHref('/live/thr_x/')).toBe('/live/thr_x/');
		expect(safeHref('javascript:x')).toBeNull();
		expect(safeHref('relative/path')).toBeNull();
		expect(safeHref('//x.example')).toBeNull();
	});
});
