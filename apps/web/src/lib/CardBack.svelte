<script lang="ts">
	import {
		emptyFeed,
		type Feed,
		type QueueItem,
		type ThreadDiff,
		type ThreadView
	} from '@tenzo/client-runtime';
	import { backLabels, changeView, errorBack, whyBack } from '#lib/back.ts';
	import { finishedView, type Shot } from '#lib/finished.ts';
	import { renderMarkdown } from '#lib/markdown.ts';
	import { command, tenzo, watchThread } from '#lib/tenzo.svelte.ts';

	// The back of a card (PRODUCT.md §5): why it's asking, the change, or what went wrong; and one
	// tap deeper, what happened so far. Card.svelte turns it over; the answers stay below it.

	interface Props {
		item: QueueItem;
		/** The item's thread, when the Pass has it: for its worktree and title. */
		thread: ThreadView | undefined;
		liveOrigin: string | null;
		/** Shows a screenshot full screen (the card's own viewer). */
		onenlarge: (shot: Shot) => void;
		/** Leaving for the timeline: the card is to be turned over still when you come back. */
		ondeeper: () => void;
	}
	let { item, thread, liveOrigin, onenlarge, ondeeper }: Props = $props();

	const labels = $derived(backLabels(item));

	// Why it's asking: the thread's events, live while the back is showing.
	let feed = $state.raw<Feed | null>(null);
	$effect(() => {
		if (labels.kind === 'change') return;
		return watchThread(item.threadId, (next) => (feed = next));
	});
	const why = $derived(
		labels.kind === 'why'
			? whyBack(item, (feed ?? emptyFeed(item.threadId)).events, thread?.worktreePath ?? '')
			: null
	);
	// What it was doing when it stopped: the same events.
	const stopped = $derived(
		labels.kind === 'error'
			? errorBack(item, (feed ?? emptyFeed(item.threadId)).events, thread?.worktreePath ?? '')
			: null
	);

	// The change: counted by the daemon when the back is turned to (and again once online).
	let diff = $state.raw<ThreadDiff | null>(null);
	let diffError = $state<string | null>(null);
	$effect(() => {
		if (labels.kind !== 'change' || diff || !tenzo.online) return;
		let gone = false;
		diffError = null;
		command({ type: 'thread.diff', threadId: item.threadId })
			.then((d) => !gone && (diff = d))
			.catch((error: unknown) => {
				if (!gone) diffError = error instanceof Error ? error.message : String(error);
			});
		return () => (gone = true);
	});
	const change = $derived(diff ? changeView(diff) : null);
	const done = $derived(finishedView(item, thread?.title ?? '', liveOrigin));
</script>

{#snippet label(text: string)}
	<h3 class="mb-2 text-[13px] font-semibold tracking-[0.06em] text-faint uppercase">{text}</h3>
{/snippet}

{#snippet chips(paths: string[], more: number)}
	<ul class="flex flex-wrap gap-1.5 font-mono text-[13px]">
		{#each paths as path (path)}
			<li class="max-w-full truncate rounded-lg bg-fill px-2.5 py-1.5 text-ink-soft" title={path}>{path}</li>
		{/each}
		{#if more > 0}<li class="px-1 py-1.5 text-faint">+{more} more</li>{/if}
	</ul>
{/snippet}

<div class="flex flex-col gap-5" data-testid="back" data-back={labels.kind}>
	{#if why}
		{#if why.reasoning}
			<div class="md text-[17px] leading-[1.45] text-ink-soft" data-testid="reasoning">
				<!-- Escaped and limited to a few tags by markdown.ts: nothing in it can run. -->
				{@html renderMarkdown(why.reasoning)}
			</div>
		{:else if feed?.status === 'loading'}
			<p class="text-[15px] text-faint">Loading…</p>
		{/if}

		{#if item.permission}
			<div class="flex flex-col gap-2 text-[15px] leading-snug" data-testid="details">
				{#if item.permission.reason}<p class="text-ink-soft">{item.permission.reason}</p>{/if}
				<p class="text-mute">{item.permission.toolName}</p>
				<pre class="rounded-2xl bg-fill px-4 py-3 font-mono text-[13px] break-words whitespace-pre-wrap text-ink-soft">{JSON.stringify(item.permission.input, null, 2)}</pre>
			</div>
		{/if}

		{#each why.weighed as w, i (i)}
			<div class="flex flex-col gap-2.5" data-testid="weighed">
				{#if w.question}<p class="text-[15px] font-semibold text-ink">{w.question}</p>{/if}
				{#each w.choices as choice, j (j)}
					<div
						class={[
							'rounded-2xl bg-fill px-4 py-3.5',
							choice.suggested && 'border-l-[3px] border-clay'
						]}
						data-suggested={choice.suggested}
						data-testid="choice"
					>
						<p class="mb-0.5 text-[16px] font-semibold">{choice.label}</p>
						{#if choice.description}<p class="text-[15px] leading-snug text-ink-soft">{choice.description}</p>{/if}
					</div>
				{/each}
			</div>
		{/each}

		{#if why.files.changed.length > 0}
			<section data-testid="changed">
				{@render label('Changed so far')}
				{@render chips(why.files.changed, why.files.moreChanged)}
			</section>
		{/if}
		{#if why.files.read.length > 0}
			<section data-testid="read">
				{@render label('Looked at')}
				{@render chips(why.files.read, why.files.moreRead)}
			</section>
		{/if}
	{:else if labels.kind === 'change'}
		{#if item.ready}
			<!-- A ready PR: the PR, where it stands in the agent's words, then the change itself. -->
			<section class="flex flex-col gap-3" data-testid="ready-back">
				{#if /^https?:\/\//i.test(item.ready.url)}
					<a
						href={item.ready.url}
						target="_blank"
						rel="noopener noreferrer"
						class="opt flex min-h-[52px] items-center justify-between gap-3 rounded-2xl bg-fill px-4 text-[16px] text-ink"
						data-testid="back-pr-link"
					>
						<span class="min-w-0 truncate">{item.ready.url.replace(/^https?:\/\//i, '')}</span>
						<svg class="shrink-0" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"></path><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"></path></svg>
					</a>
				{/if}
				{#if item.ready.summary.trim()}
					<div class="md text-[16px] leading-[1.45] text-ink-soft">
						<!-- Escaped and limited to a few tags by markdown.ts: nothing in it can run. -->
						{@html renderMarkdown(item.ready.summary)}
					</div>
				{/if}
			</section>
		{/if}
		<div class="flex flex-col gap-1">
			{#if done || item.ready}
				<span class="text-[13px] font-semibold tracking-[0.06em] text-done uppercase">{done?.headline ?? item.ask}</span>
			{/if}
			<span class="text-[22px] font-bold tracking-[-0.02em]" data-testid="change-headline">
				{change?.headline ?? (diffError ? 'The change' : 'Counting the change…')}
			</span>
			{#if diff}<span class="text-[14px] text-faint">against {diff.base}</span>{/if}
		</div>
		{#if diffError}
			<p class="text-[15px] leading-snug text-clay" role="alert">{diffError}</p>
		{/if}
		{#if change && change.lines.length > 0}
			<ul class="overflow-hidden rounded-[18px] bg-fill font-mono text-[14px]" data-testid="files">
				{#each change.lines as line, i (line.key)}
					{#if i > 0}<li class="ml-4 h-px bg-fill-strong" aria-hidden="true"></li>{/if}
					<li class="flex min-h-[46px] items-center justify-between gap-3 px-4 py-2" data-testid="file">
						<span class="min-w-0 break-all text-ink">{line.path}</span>
						<span class="shrink-0 text-[13px] whitespace-nowrap">
							{#if line.added}<span class="text-done">{line.added}</span>{/if}
							{#if line.deleted}<span class="text-fail">{line.deleted}</span>{/if}
							{#if line.note}<span class="text-faint">{line.note}</span>{/if}
						</span>
					</li>
				{/each}
			</ul>
			{#if change.more}<p class="text-[14px] text-faint">{change.more}</p>{/if}
		{/if}
		{#if done?.howToTestHtml}
			<section>
				{@render label('How to try it')}
				<div class="md text-[16px] leading-[1.45] text-ink-soft">{@html done.howToTestHtml}</div>
			</section>
		{/if}
		{#if done && (done.shots.length > 0 || done.live)}
			<div class="scroll -mx-[22px] flex gap-2.5 overflow-x-auto px-[22px]">
				{#each done.shots as shot (shot.url)}
					<button
						type="button"
						class="opt h-[150px] w-24 shrink-0 overflow-hidden rounded-[14px] bg-fill"
						aria-label={`Enlarge: ${shot.alt}`}
						onclick={() => onenlarge(shot)}
					>
						<img src={shot.url} alt={shot.alt} class="size-full object-cover object-top" loading="lazy" />
					</button>
				{/each}
				{#if done.live}
					<a href={done.live} target="_blank" rel="noopener" class="opt flex h-[150px] min-w-24 grow flex-col items-center justify-center gap-2 rounded-[14px] bg-fill px-4 text-[14px] font-medium text-ink">
						<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9"></path><path d="M19 13v6a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h6"></path></svg>
						Open live
					</a>
				{/if}
			</div>
		{/if}
	{:else if stopped}
		<!-- The front says what went wrong; this says what it was doing. -->
		{#if stopped.retry.kind === 'resend'}
			<section data-testid="retry" data-retry="resend">
				{@render label(stopped.retry.prompts.length === 1 ? 'Retry sends' : 'Retry sends, in order')}
				<ul class="flex flex-col gap-2">
					{#each stopped.retry.prompts as prompt, i (i)}
						<li class="rounded-2xl bg-fill px-4 py-3 text-[15px] leading-snug break-words whitespace-pre-line text-ink-soft">{prompt}</li>
					{/each}
				</ul>
			</section>
		{:else}
			<section data-testid="retry" data-retry="carry-on">
				{@render label('Retry')}
				<p class="text-[15px] leading-snug text-ink-soft">
					Tells it the turn didn't finish, and to check what's already done before it carries on.
				</p>
				{#if stopped.retry.began}
					<p class="mt-3 mb-1.5 text-[13px] font-semibold tracking-[0.06em] text-faint uppercase">The turn began with</p>
					<p class="rounded-2xl bg-fill px-4 py-3 text-[15px] leading-snug break-words whitespace-pre-line text-ink-soft">{stopped.retry.began}</p>
				{/if}
			</section>
		{/if}
		{#if stopped.lastSaid}
			<section data-testid="last-said">
				{@render label('Last it said')}
				<div class="md text-[16px] leading-[1.45] text-ink-soft">{@html renderMarkdown(stopped.lastSaid)}</div>
			</section>
		{/if}
		{#if stopped.lastSteps.length > 0}
			<section data-testid="last-steps">
				{@render label('Last steps')}
				<ul class="flex flex-col gap-1 font-mono text-[13px]">
					{#each stopped.lastSteps as step, i (i)}
						<li class={['break-words', step.failed ? 'text-fail' : 'text-mute']}>{step.summary}</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if stopped.files.changed.length > 0}
			<section>
				{@render label('Changed so far')}
				{@render chips(stopped.files.changed, stopped.files.moreChanged)}
			</section>
		{/if}
		{#if feed?.status === 'loading' && !stopped.lastSaid}
			<p class="text-[15px] text-faint">Loading…</p>
		{/if}
	{/if}

	<a
		href={`/threads/${item.threadId}`}
		class="opt flex min-h-[52px] items-center justify-between rounded-2xl bg-fill px-4 text-[16px] text-ink"
		onclick={ondeeper}
		data-testid="so-far"
	>
		<span>What happened so far</span>
		<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"></path></svg>
	</a>
</div>
