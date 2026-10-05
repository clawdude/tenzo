<script lang="ts">
	import { isSnoozed } from '@tenzo/client-runtime';
	import { onMount } from 'svelte';
	import { appear, move, vanish } from '#lib/motion.ts';
	import { leaveTo } from '#lib/nav.ts';
	import { connectionLabel } from '#lib/status.ts';
	import { tenzo } from '#lib/tenzo.svelte.ts';
	import { entriesOf, groupThreads, type GroupKey, type Tone } from '#lib/threads.ts';

	// Threads: every active thread, grouped by what it is doing, live from the daemon. One card
	// tone and no lines: each group is a stack of slices on the black ground, and what is finished
	// sits a layer further back. A thread changing group slides to its new place.
	let now = $state(Date.now());
	const live = $derived(tenzo.state);
	const entries = $derived(entriesOf(groupThreads(live.threads, live.items, now)));
	/** What the Pass has for you now: snoozed items wait elsewhere. */
	const waiting = $derived(live.items.filter((i) => !isSnoozed(i)).length);
	/** Rows move once the list has drawn: what arrives with the first snapshot just appears. */
	let moving = $state(false);

	const DOTS: Record<Tone, string> = {
		clay: 'bg-clay',
		working: 'bg-working',
		done: 'bg-done',
		waiting: 'bg-dim',
		quiet: 'bg-fill'
	};
	const HEADS: Record<GroupKey, string> = {
		'needs-you': 'text-clay',
		working: 'text-mute',
		landing: 'text-mute',
		today: 'text-back-ink',
		earlier: 'text-back-ink'
	};

	$effect(() => {
		if (!tenzo.seen || moving) return;
		const frame = requestAnimationFrame(() => (moving = true));
		return () => cancelAnimationFrame(frame);
	});

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
			<span class="flex shrink-0 items-center gap-2.5">
				{#if live.automations.length > 0 || live.automationProblems.length > 0}
					<!-- The automations: what runs by itself, quietly beside the way back. -->
					<a
						href="/automations"
						aria-label="Automations"
						class="opt flex size-11 shrink-0 items-center justify-center rounded-full bg-card text-mute"
						data-testid="to-automations"
					>
						<svg width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path></svg>
					</a>
				{/if}
				<!-- Back to the Pass; clay with the pile's height while something waits for you. -->
				<button
					type="button"
					aria-label={waiting > 0 ? `The Pass, ${waiting} waiting` : 'The Pass'}
					class={[
						'opt flex size-11 shrink-0 items-center justify-center rounded-full text-[15px] font-bold',
						// Turns clay as things come in, but is drawn clay at once on arrival.
						moving && 'transition-colors',
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
			</span>
		</header>

		{#if tenzo.seen && entries.length === 0}
			<p class="px-6 text-[17px] text-mute" data-testid="no-threads">
				No threads yet. Start one with New.
			</p>
		{/if}

		<!--
			One run of headings and rows, so a thread changing group is the same row moving (a list
			per group would make it a different element). Each heading is an item of the list too.
		-->
		<div class="relative flex flex-col px-5" role="list" aria-label="Threads">
			{#each entries as entry (entry.key)}
				<div role="listitem" animate:move in:appear={moving} out:vanish>
					{#if entry.kind === 'head'}
						<h2
							class={[
								'px-1 pb-1.5 text-[13px] font-semibold tracking-[0.06em] uppercase transition-colors',
								!entry.first && 'pt-[26px]',
								HEADS[entry.group]
							]}
							data-testid="group"
							data-group={entry.group}
						>
							{entry.label}
						</h2>
					{:else}
						{@const row = entry.row}
						{@const tile = [
							'flex min-h-14 items-center gap-3.5 px-[18px] py-2',
							'transition-[background-color,border-radius] duration-[380ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none',
							entry.top ? 'rounded-t-[20px]' : 'rounded-t-[6px]',
							entry.bottom ? 'rounded-b-[20px]' : 'rounded-b-[6px]',
							entry.back ? 'bg-card-back' : 'bg-card'
						]}
						<div
							class={[!entry.top && 'pt-0.5']}
							data-testid="thread-row"
							data-id={row.thread.id}
							data-group={entry.group}
							data-word={row.word}
						>
							{#snippet content()}
								<span
									class={[
										'size-2 shrink-0 rounded-full transition-[background-color,opacity] duration-300 motion-reduce:transition-none',
										DOTS[row.tone],
										// Finished work's green sits back with its layer.
										entry.back && 'opacity-60'
									]}
								></span>
								<span class="flex min-w-0 grow flex-col">
									<span class={['truncate', entry.back && 'text-mute']} data-testid="thread-title"
										>{row.thread.title}</span
									>
									{#if row.origin}
										<!-- Started by another thread's agent, or by an automation, not by you. -->
										<span
											class="flex min-w-0 items-center gap-1 text-[13px] leading-[1.3] text-mute"
											data-testid="origin"
											data-kind={row.origin.kind}
										>
											{#if row.origin.kind === 'automation'}
												<svg class="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"></circle><path d="M12 7.5V12l3 2"></path></svg>
											{:else}
												<svg class="shrink-0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4v7a4 4 0 0 0 4 4h9"></path><path d="M15 11l4 4-4 4"></path></svg>
											{/if}
											<span class="truncate">{row.origin.label}</span>
										</span>
									{/if}
								</span>
								<span class={['shrink-0 text-[15px]', entry.back ? 'text-back-ink' : 'text-mute']}
									>{row.word}</span
								>
							{/snippet}
							{#if entry.group === 'needs-you'}
								<!-- What it needs is on the Pass. -->
								<a
									href="/"
									class={tile}
									onclick={(e) => {
										e.preventDefault();
										leaveTo('/');
									}}>{@render content()}</a
								>
							{:else}
								<!-- What happened so far, live. -->
								<a href={`/threads/${row.thread.id}`} class={tile} data-testid="open-thread"
									>{@render content()}</a
								>
							{/if}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>

	<!-- New floats over the list; the list fades out under it. -->
	<div
		class="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-linear-to-t from-black from-40% to-transparent pt-12 pb-[calc(env(safe-area-inset-bottom)+24px)]"
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
