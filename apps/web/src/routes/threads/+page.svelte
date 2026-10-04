<script lang="ts">
	import { isSnoozed } from '@tenzo/client-runtime';
	import { onMount } from 'svelte';
	import { leaveTo } from '#lib/nav.ts';
	import { connectionLabel } from '#lib/status.ts';
	import { tenzo } from '#lib/tenzo.svelte.ts';
	import { groupThreads, type GroupKey, type Tone } from '#lib/threads.ts';

	// Threads: every active thread, grouped by what it is doing, live from the daemon.
	let now = $state(Date.now());
	const live = $derived(tenzo.state);
	const groups = $derived(groupThreads(live.threads, live.items, now));
	/** What the Pass has for you now: snoozed items wait elsewhere. */
	const waiting = $derived(live.items.filter((i) => !isSnoozed(i)).length);

	const DOTS: Record<Tone, string> = {
		clay: 'bg-clay',
		working: 'bg-working',
		done: 'bg-done',
		quiet: 'bg-fill'
	};
	const HEADS: Record<GroupKey, string> = {
		'needs-you': 'text-clay',
		working: 'text-mute',
		landing: 'text-mute',
		today: 'text-faint',
		earlier: 'text-faint'
	};
	/** Finished threads sit back a little, as in the mock-up. */
	const quiet = (key: GroupKey) => key === 'today' || key === 'earlier';

	onMount(() => {
		const tick = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(tick);
	});
</script>

<svelte:head>
	<title>Threads · Tenzo</title>
</svelte:head>

<main class="fixed inset-0 overflow-hidden bg-black text-ink" data-testid="threads-list">
	<div
		class="scroll mx-auto flex h-full w-full max-w-[440px] flex-col overflow-y-auto pt-[calc(env(safe-area-inset-top)+14px)] pb-[calc(env(safe-area-inset-bottom)+110px)] sm:pt-6"
	>
		<header class="mb-[22px] flex items-end justify-between gap-4 px-6">
			<div class="flex min-w-0 flex-col gap-0.5">
				<h1 class="text-[34px] leading-[1.1] font-bold tracking-[-0.02em]">Threads</h1>
				<p class="truncate text-[15px] text-mute" aria-live="polite" data-testid="summary">
					{#if !tenzo.online}
						{connectionLabel(live.connection)}
					{:else}
						{live.threads.length} open
					{/if}
				</p>
			</div>
			<!-- Back to the Pass; clay with the pile's height while something waits for you. -->
			<button
				type="button"
				aria-label={waiting > 0 ? `The Pass, ${waiting} waiting` : 'The Pass'}
				class={[
					'opt flex size-11 shrink-0 items-center justify-center rounded-full text-[15px] font-bold',
					waiting > 0 ? 'bg-clay text-on-clay' : 'bg-card text-ink'
				]}
				onclick={() => leaveTo('/')}
				data-testid="to-pass"
			>
				{#if waiting > 0}
					{waiting}
				{:else}
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
				{/if}
			</button>
		</header>

		{#if tenzo.seen && groups.length === 0}
			<p class="px-6 text-[17px] text-mute" data-testid="no-threads">
				No threads yet. Start one with New.
			</p>
		{/if}

		<div class="flex flex-col gap-[26px] px-5">
			{#each groups as group (group.key)}
				<section class="flex flex-col gap-1.5" data-testid="group" data-group={group.key}>
					<h2
						class={[
							'px-1 text-[13px] font-semibold tracking-[0.06em] uppercase',
							HEADS[group.key]
						]}
					>
						{group.label}
					</h2>
					<ul
						class={[
							'overflow-hidden rounded-[20px]',
							quiet(group.key) ? 'bg-[#0e0e10]' : 'bg-card'
						]}
					>
						{#each group.rows as row, i (row.thread.id)}
							{#if i > 0}
								<li
									class={['ml-10 h-px', quiet(group.key) ? 'bg-card' : 'bg-fill']}
									aria-hidden="true"
								></li>
							{/if}
							<li data-testid="thread-row" data-id={row.thread.id} data-word={row.word}>
								{#snippet content()}
									<span class={['size-2 shrink-0 rounded-full', DOTS[row.tone]]}></span>
									<span
										class={['min-w-0 grow truncate', quiet(group.key) && 'text-mute']}
										data-testid="thread-title">{row.thread.title}</span
									>
									<span
										class={[
											'shrink-0 text-[15px]',
											quiet(group.key) ? 'text-faint' : 'text-mute'
										]}>{row.word}</span
									>
								{/snippet}
								{#if group.key === 'needs-you'}
									<!-- What it needs is on the Pass. -->
									<a href="/" class="flex min-h-14 items-center gap-3.5 px-[18px]" onclick={(e) => {
										e.preventDefault();
										leaveTo('/');
									}}>{@render content()}</a>
								{:else}
									<!-- What happened so far, live. -->
									<a
										href={`/threads/${row.thread.id}`}
										class="flex min-h-14 items-center gap-3.5 px-[18px]"
										data-testid="open-thread">{@render content()}</a
									>
								{/if}
							</li>
						{/each}
					</ul>
				</section>
			{/each}
		</div>
	</div>

	<div
		class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-[calc(env(safe-area-inset-bottom)+24px)]"
	>
		<a
			href="/new"
			class="opt pointer-events-auto flex min-h-[52px] items-center gap-2.5 rounded-full bg-card pr-[22px] pl-[18px] text-[16px] font-medium shadow-[0_12px_32px_rgba(0,0,0,.6)]"
			data-testid="new"
		>
			<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>
			New
		</a>
	</div>
</main>
