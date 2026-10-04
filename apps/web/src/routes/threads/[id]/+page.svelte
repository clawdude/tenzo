<script lang="ts">
	import { page } from '$app/state';
	import { emptyFeed, type Feed } from '@tenzo/client-runtime';
	import ModelMenu from '#lib/ModelMenu.svelte';
	import { runningModel } from '#lib/model.ts';
	import Timeline from '#lib/Timeline.svelte';
	import { back, leaveTo } from '#lib/nav.ts';
	import { connectionLabel } from '#lib/status.ts';
	import { tenzo, watchThread } from '#lib/tenzo.svelte.ts';
	import { sessionOf } from '#lib/timeline.ts';

	// One thread, what happened so far: reached from a row of the Threads list, or one tap deeper
	// than a card's back. Live while you look.
	const threadId = $derived(page.params.id ?? '');
	let feed = $state.raw<Feed>(emptyFeed(''));
	$effect(() => watchThread(threadId, (next) => (feed = next)));

	const live = $derived(tenzo.state);
	/** The thread as the Pass knows it; an archived one only as the watch found it. */
	const thread = $derived(live.threads.find((t) => t.id === threadId) ?? feed.thread);
	/** What it needs from you, if anything: that is on the Pass. */
	const waiting = $derived(live.items.find((i) => i.threadId === threadId));
	const session = $derived(sessionOf(feed.events));
</script>

<svelte:head>
	<title>{thread?.title ?? 'Thread'} · Tenzo</title>
</svelte:head>

<main class="fixed inset-0 flex flex-col overflow-hidden bg-black text-ink" data-testid="thread-view">
	<div
		class="mx-auto flex h-full w-full max-w-[440px] flex-col pt-[calc(env(safe-area-inset-top)+10px)] pb-[env(safe-area-inset-bottom)] sm:pt-6"
	>
		<header class="flex shrink-0 items-center justify-between px-4">
			<button
				type="button"
				class="opt flex min-h-11 items-center gap-1 px-2 text-[17px] text-clay"
				onclick={back}
				data-testid="back"
			>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 6l-6 6 6 6"></path></svg>
				Back
			</button>
			<span class="text-[13px] font-semibold tracking-[0.06em] text-mute uppercase">So far</span>
			<span class="flex w-[72px] justify-end">
				{#if thread}
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
		<Timeline {feed} root={thread?.worktreePath ?? ''} working={Boolean(thread?.working) && !waiting}>
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

		{#if waiting}
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
		{/if}
	</div>
</main>
