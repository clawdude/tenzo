<script lang="ts">
	import { page } from '$app/state';
	import { emptyFeed, type Feed } from '@tenzo/client-runtime';
	import ArchiveSheet from '#lib/ArchiveSheet.svelte';
	import Composer from '#lib/Composer.svelte';
	import { asShown, footOf, type Pending, stillWaiting } from '#lib/composer.ts';
	import ModelMenu from '#lib/ModelMenu.svelte';
	import { runningModel } from '#lib/model.ts';
	import Timeline from '#lib/Timeline.svelte';
	import { back, leaveTo } from '#lib/nav.ts';
	import { connectionLabel } from '#lib/status.ts';
	import { tenzo, watchThread } from '#lib/tenzo.svelte.ts';
	import { sessionOf } from '#lib/timeline.ts';

	// One thread, what happened so far: reached from a row of the Threads list, or one tap deeper
	// than a card's back. Live while you look. At its foot, a field for the next message, or the
	// way to the Pass when something waits on you there.
	const threadId = $derived(page.params.id ?? '');
	let feed = $state.raw<Feed>(emptyFeed(''));
	$effect(() => watchThread(threadId, (next) => (feed = next)));

	const live = $derived(tenzo.state);
	/** The thread as the Pass knows it; an archived one as the watch found it and its log says. */
	const thread = $derived(asShown(live.threads.find((t) => t.id === threadId) ?? feed.thread, feed.events));
	/** A field for the next message, the way to the Pass, or nothing (archived). */
	const foot = $derived(footOf(thread, live.items));
	const session = $derived(sessionOf(feed.events));
	/** Messages sent from here that haven't started a turn yet. */
	let sent = $state.raw<Pending[]>([]);
	const waiting = $derived(stillWaiting(sent, feed.events, thread));
	let archiving = $state(false);

	function onsent(text: string) {
		sent = [...stillWaiting(sent, feed.events, thread), { text, after: feed.events.at(-1)?.seq ?? 0 }];
	}
</script>

<svelte:head>
	<title>{thread?.title ?? 'Thread'} · Tenzo</title>
</svelte:head>

<main class="fixed inset-0 flex flex-col overflow-hidden bg-black text-ink" data-testid="thread-view">
	<div
		class="mx-auto flex h-full w-full max-w-[440px] flex-col pt-[calc(env(safe-area-inset-top)+10px)] pb-[env(safe-area-inset-bottom)] sm:pt-6"
	>
		<header class="grid shrink-0 grid-cols-[1fr_auto_1fr] items-center px-4">
			<span class="flex justify-start">
				<button
					type="button"
					class="opt flex min-h-11 items-center gap-1 px-2 text-[17px] text-clay"
					onclick={back}
					data-testid="back"
				>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"></path></svg>
					Back
				</button>
			</span>
			<span class="text-[13px] font-semibold tracking-[0.06em] text-mute uppercase">So far</span>
			<span class="flex items-center justify-end gap-1">
				{#if thread}
					{#if thread.status === 'active'}
						<button
							type="button"
							class="opt min-h-9 rounded-full bg-card px-3.5 text-[15px] text-ink-soft"
							onclick={() => (archiving = true)}
							data-testid="archive">Archive</button
						>
					{/if}
					<ModelMenu {thread} running={runningModel(feed.events)} />
				{/if}
			</span>
		</header>

		<div class="shrink-0 px-6 pt-2 pb-3">
			<h1 class="text-[24px] leading-[1.2] font-bold tracking-[-0.02em] break-words" data-testid="thread-title">
				{thread?.title ?? ''}
			</h1>
			<p class="truncate text-[14px] text-mute">
				{#if !tenzo.online}
					{connectionLabel(live.connection)}
				{:else if thread}
					{thread.projectName} · {thread.branch}{thread.status === 'archived' ? ' · archived' : ''}
				{/if}
			</p>
		</div>

		{#key threadId}
		<Timeline
			{feed}
			root={thread?.worktreePath ?? ''}
			working={Boolean(thread?.working) && foot !== 'pass'}
			queued={waiting.map((p) => p.text)}
		>
			{#snippet footer()}
				{#if session}
					<!-- The full transcript stays Claude's (PRODUCT.md §10): this is where it is. -->
					<p class="mt-6 text-center text-[13px] leading-snug text-faint" data-testid="transcript">
						Full transcript: <code class="font-mono">claude --resume {session}</code> in the thread's worktree
					</p>
				{/if}
			{/snippet}
		</Timeline>
		{/key}

		{#if foot === 'pass'}
			<div class="shrink-0 px-4 pt-3 pb-4">
				<button
					type="button"
					class="opt flex min-h-14 w-full items-center justify-center rounded-[18px] bg-clay px-4 text-[17px] font-semibold text-on-clay"
					onclick={() => leaveTo('/')}
					data-testid="to-pass"
				>
					It needs you: on the Pass
				</button>
			</div>
		{:else if foot === 'field' && thread}
			{#key threadId}
				<Composer {thread} {onsent} />
			{/key}
		{/if}
	</div>
</main>

{#if archiving && thread && thread.status === 'active'}
	<ArchiveSheet {thread} onclose={() => (archiving = false)} />
{/if}
