<script lang="ts">
	import { canLoadOlder, type Feed, type StoredEvent } from '@tenzo/client-runtime';
	import { type Snippet, tick } from 'svelte';
	import { renderMarkdown } from '#lib/markdown.ts';
	import {
		clip,
		clockOf,
		heldEvents,
		ROW_PAGE,
		type Row,
		timelineOf,
		windowOf
	} from '#lib/timeline.ts';
	import { loadOlder } from '#lib/tenzo.svelte.ts';

	// What happened so far: a thread's events as a timeline (the mock-up's B2), live. Only the end
	// of a long thread is drawn; "Earlier" adds a page at a time, from the daemon when needed.

	interface Props {
		feed: Feed;
		/** The thread is working now: a last row says so. */
		working?: boolean;
		/** Drawn after the last row. */
		footer?: Snippet;
		/** The thread's worktree: paths in it are shown relative to it. */
		root?: string;
	}
	let { feed, working = false, footer, root = '' }: Props = $props();

	/** Following the end: new rows scroll into view. Off once you scroll up to read. */
	let following = $state(true);
	/** The events drawn last: reading further up, they stay put (heldEvents). */
	let drawn: readonly StoredEvent[] = [];
	const held = $derived.by(() => {
		const next = heldEvents(drawn, feed.events, following);
		drawn = next.events;
		return next;
	});
	const rows = $derived(timelineOf(held.events, root));
	/** How many of the last rows are drawn. */
	let count = $state(ROW_PAGE);
	const view = $derived(windowOf(rows, count));
	/** Earlier events the daemon can still page in (none once the feed is full). */
	const pageable = $derived(canLoadOlder(feed));
	/** Rows (and calls, and outputs) opened by a tap, by key. */
	let opened = $state<Record<string, boolean>>({});
	let scroller = $state<HTMLElement | null>(null);

	const toggle = (key: string) => (opened[key] = !opened[key]);

	function onscroll() {
		if (!scroller) return;
		following = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
	}

	// At the end, whatever changes (a new row, an output arriving), the end stays in view.
	$effect.pre(() => {
		void held.events;
		if (!following) return;
		void tick().then(() => {
			if (following && scroller) scroller.scrollTop = scroller.scrollHeight;
		});
	});

	/** Back to the end, where what waited is drawn. */
	function toEnd() {
		following = true;
		void tick().then(() => scroller && (scroller.scrollTop = scroller.scrollHeight));
	}

	async function earlier() {
		const el = scroller;
		const from = el ? el.scrollHeight - el.scrollTop : 0;
		if (view.hidden === 0) await loadOlder(feed.threadId).catch(() => {});
		count += ROW_PAGE;
		await tick();
		// Keep what you were reading where it was.
		if (el) el.scrollTop = el.scrollHeight - from;
	}

	const DOT: Record<string, string> = {
		quiet: 'bg-fill-strong',
		asking: 'bg-clay',
		working: 'bg-working animate-pulse motion-reduce:animate-none',
		done: 'bg-done',
		fail: 'bg-fail'
	};

	function toneOf(row: Row): keyof typeof DOT {
		switch (row.kind) {
			case 'tools':
				return row.running ? 'working' : row.failed > 0 ? 'fail' : 'quiet';
			case 'question':
			case 'permission':
			case 'proposal':
			case 'ready':
				return row.answer === null ? 'asking' : 'quiet';
			case 'report':
			case 'landed':
				return 'done';
			case 'started':
				return row.failed ? 'fail' : 'quiet';
			case 'note':
				return row.tone === 'fail' ? 'fail' : 'quiet';
			default:
				return 'quiet';
		}
	}

	/** Text of `key`, whole once opened, else cut to a few lines. */
	function shown(key: string, text: string, size: { chars: number; lines: number }) {
		if (opened[key]) return { head: text, more: false, cut: true };
		const c = clip(text, size);
		return { ...c, cut: c.more };
	}

	const SAID = { chars: 900, lines: 14 };
	const OUTPUT = { chars: 500, lines: 8 };
	const PROMPT = { chars: 400, lines: 5 };
</script>

<div
	class="scroll min-h-0 grow overflow-y-auto px-6 pb-10 [overflow-anchor:none]"
	bind:this={scroller}
	{onscroll}
	data-testid="timeline"
	data-rows={rows.length}
	data-following={following}
	data-newer={held.newer}
	data-status={feed.status}
>
	{#if view.hidden > 0 || pageable}
		<button
			type="button"
			class="opt mb-2 flex min-h-11 w-full items-center justify-center text-[15px] text-mute"
			onclick={earlier}
			disabled={feed.loadingOlder}
			data-testid="earlier"
		>
			{feed.loadingOlder ? 'Loading…' : 'Earlier'}
		</button>
	{:else if feed.older}
		<!-- The feed is full: earlier steps stay on the daemon (and all of it in Claude's transcript). -->
		<p class="mb-2 py-3 text-center text-[14px] text-faint" data-testid="limit">
			Earlier steps aren't kept on this screen.
		</p>
	{/if}

	{#if feed.status === 'loading' && rows.length === 0}
		<p class="py-6 text-[15px] text-faint">Loading…</p>
	{:else if feed.status === 'failed'}
		<p class="py-6 text-[15px] text-clay" role="alert">{feed.error}</p>
	{:else if rows.length === 0}
		<p class="py-6 text-[15px] text-faint">Nothing yet.</p>
	{/if}

	<ol class="flex flex-col">
		{#each view.shown as row, i (row.key)}
			{@const last = i === view.shown.length - 1 && !working}
			<li class="flex gap-3.5 py-2.5" data-testid="row" data-kind={row.kind} data-key={row.key}>
				<div class="flex w-3 shrink-0 flex-col items-center" aria-hidden="true">
					<span class={['mt-[7px] size-2 rounded-full', DOT[toneOf(row)]]}></span>
					{#if !last}<span class="mt-1.5 w-px grow bg-fill"></span>{/if}
				</div>
				<div class="flex min-w-0 grow flex-col gap-1">
					{#snippet head(title: string, strong = false)}
						<div class="flex items-baseline justify-between gap-3">
							<span class={['min-w-0 text-[16px] break-words', strong ? 'font-semibold text-ink' : 'text-ink-soft']}>{title}</span>
							<span class="shrink-0 text-[13px] text-faint tabular-nums">{clockOf(row.at)}</span>
						</div>
					{/snippet}
					{#snippet link(url: string, text: string)}
						{#if /^https?:\/\//i.test(url)}
							<a href={url} target="_blank" rel="noopener noreferrer" class="self-start text-[14px] text-ink underline underline-offset-2">{text}</a>
						{/if}
					{/snippet}
					{#snippet more(key: string, cut: boolean)}
						{#if cut}
							<button type="button" class="self-start text-[14px] text-mute underline-offset-2 hover:underline" onclick={() => toggle(key)} data-testid="show-more">
								{opened[key] ? 'Show less' : 'Show more'}
							</button>
						{/if}
					{/snippet}

					{#if row.kind === 'prompt'}
						{@const t = shown(row.key, row.text, PROMPT)}
						{@render head('You', true)}
						<p class="text-[15px] leading-snug break-words whitespace-pre-line text-ink-soft">{t.head}{t.more ? '…' : ''}</p>
						{@render more(row.key, t.cut)}
					{:else if row.kind === 'said'}
						{@const t = shown(row.key, row.text, SAID)}
						<div class="flex items-start justify-between gap-3">
							<div class="md min-w-0 text-[16px] leading-[1.45] text-ink-soft">
								<!-- Escaped and limited to a few tags by markdown.ts: nothing in it can run. -->
								{@html renderMarkdown(t.more ? `${t.head}…` : t.head)}
							</div>
							<span class="shrink-0 pt-0.5 text-[13px] text-faint tabular-nums">{clockOf(row.at)}</span>
						</div>
						{@render more(row.key, t.cut)}
					{:else if row.kind === 'thought'}
						<button type="button" class="text-left" onclick={() => toggle(row.key)} aria-expanded={!!opened[row.key]}>
							{@render head('Thought it over')}
						</button>
						{#if opened[row.key]}
							<p class="text-[14px] leading-snug break-words whitespace-pre-line text-mute">{row.text}</p>
						{/if}
					{:else if row.kind === 'tools'}
						<button
							type="button"
							class="flex flex-col text-left"
							onclick={() => toggle(row.key)}
							aria-expanded={!!opened[row.key]}
							data-testid="tools"
						>
							{@render head(row.title)}
							{#if !opened[row.key] && (row.calls.length > 1 || row.failed > 0)}
								<span class="truncate font-mono text-[13px] text-mute">
									{row.failed > 0 ? `${row.failed} failed · ` : ''}{row.calls.at(-1)?.summary}
								</span>
							{/if}
						</button>
						{#if opened[row.key]}
							<ul class="flex flex-col gap-2 pt-1" data-testid="calls">
								{#each row.calls as call (call.key)}
									{@const out = call.output ? shown(`out:${call.key}`, call.output, OUTPUT) : null}
									<li class="flex flex-col gap-1">
										<span class={['font-mono text-[13px] break-words', call.status === 'failed' ? 'text-fail' : 'text-mute']}>
											{call.summary}{call.steps > 0 ? ` · ${call.steps} steps` : ''}{call.status === 'in_progress' ? ' · running' : ''}
										</span>
										{#if out}
											<pre class="max-h-[60vh] overflow-auto rounded-[10px] bg-card px-3 py-2.5 font-mono text-[12px] leading-[1.5] whitespace-pre-wrap break-words text-ink-soft" data-testid="output">{out.head}{out.more ? '\n…' : ''}</pre>
											{@render more(`out:${call.key}`, out.cut)}
										{/if}
									</li>
								{/each}
							</ul>
						{/if}
					{:else if row.kind === 'question' || row.kind === 'permission'}
						{@render head(row.kind === 'question' ? `Asked: ${row.ask}` : `Asked to: ${row.detail}`, row.answer === null)}
						<span class="text-[14px] text-mute">{row.answer === null ? 'Waiting for you' : `You: ${row.answer}`}</span>
					{:else if row.kind === 'proposal'}
						{@const t = shown(row.key, row.summary, OUTPUT)}
						{@render head(`Proposed: ${row.headline}`, row.answer === null)}
						<div class="md text-[14px] leading-snug text-mute">{@html renderMarkdown(t.more ? `${t.head}…` : t.head)}</div>
						{@render more(row.key, t.cut)}
						<span class="text-[14px] text-mute">{row.answer === null ? 'Waiting for you' : `You: ${row.answer}`}</span>
					{:else if row.kind === 'report'}
						{@const t = shown(row.key, row.summary, OUTPUT)}
						{@render head(`Reported: ${row.headline}`, true)}
						{#if row.checks.length > 0}
							<span class="text-[14px] text-mute">
								{row.checks.map((c) => `${c.name} ${c.status === 'pass' ? '✓' : c.status === 'fail' ? '✗' : '–'}`).join(' · ')}
							</span>
						{/if}
						<div class="md text-[14px] leading-snug text-mute">{@html renderMarkdown(t.more ? `${t.head}…` : t.head)}</div>
						{@render more(row.key, t.cut)}
						{#if row.answer}<span class="text-[14px] text-mute">You: {row.answer}</span>{/if}
					{:else if row.kind === 'ready'}
						{@const t = shown(row.key, row.summary, OUTPUT)}
						{@render head(`Ready to merge: ${row.headline}`, row.answer === null)}
						<div class="md text-[14px] leading-snug text-mute">{@html renderMarkdown(t.more ? `${t.head}…` : t.head)}</div>
						{@render more(row.key, t.cut)}
						{@render link(row.url, 'Open the PR')}
						<span class="text-[14px] text-mute">{row.answer === null ? 'Waiting for you' : `You: ${row.answer}`}</span>
					{:else if row.kind === 'landed'}
						{@render head('Landed', true)}
						{#if row.summary}<p class="text-[14px] leading-snug text-mute">{row.summary}</p>{/if}
						{@render link(row.url, 'The merged PR')}
					{:else if row.kind === 'started'}
						{#if row.childId}
							<a href={`/threads/${row.childId}`} class="flex flex-col" data-testid="child-thread">
								{@render head(`Started a thread: ${row.title}`)}
								<span class="text-[14px] text-mute underline-offset-2">Open its timeline ›</span>
							</a>
						{:else}
							{@render head(row.failed ? `Couldn't start a thread: ${row.title}` : `Starting a thread: ${row.title}`)}
							{#if row.detail}<p class="text-[14px] leading-snug text-fail">{row.detail}</p>{/if}
						{/if}
					{:else if row.kind === 'note'}
						<div class="flex items-baseline justify-between gap-3">
							<span class={['min-w-0 text-[15px] break-words', row.tone === 'fail' ? 'text-fail' : 'text-mute']}>{row.text}</span>
							<span class="shrink-0 text-[13px] text-faint tabular-nums">{clockOf(row.at)}</span>
						</div>
					{/if}
				</div>
			</li>
		{/each}
		{#if working}
			<li class="flex gap-3.5 py-2.5" data-testid="working">
				<div class="flex w-3 shrink-0 justify-center" aria-hidden="true">
					<span class="mt-[7px] size-2 animate-pulse rounded-full bg-working motion-reduce:animate-none"></span>
				</div>
				<span class="text-[16px] text-mute">Working…</span>
			</li>
		{/if}
	</ol>
	{@render footer?.()}
	{#if !following && held.newer > 0}
		<!-- What came in while you read further up: waiting, so nothing you see moves. -->
		<div class="pointer-events-none sticky bottom-3 flex justify-center">
			<button
				type="button"
				class="opt pointer-events-auto flex min-h-10 items-center gap-1.5 rounded-full bg-fill-strong px-4 text-[14px] font-medium text-ink shadow-[0_8px_24px_rgba(0,0,0,.5)]"
				onclick={toEnd}
				data-testid="newer"
			>
				<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 5v14M5 12l7 7 7-7"></path></svg>
				{held.newer} new
			</button>
		</div>
	{/if}
</div>
