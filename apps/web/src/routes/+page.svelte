<script lang="ts">
	import {
		suggestedAnswer,
		TenzoClient,
		type TenzoState
	} from '@tenzo/client-runtime';
	import { onMount } from 'svelte';
	import mark from '#lib/assets/mark.svg';
	import { connectionLabel, connectionTone, daemonSocketUrl } from '#lib/status.ts';

	// A plain view of the client's store until the Pass (#8) replaces it.
	const client = new TenzoClient({ url: daemonSocketUrl(location) });
	let tenzo = $state.raw<TenzoState>(client.state);
	let failure = $state<string | null>(null);
	const tone = $derived(connectionTone(tenzo.connection));
	const threadTitle = $derived(new Map(tenzo.threads.map((t) => [t.id, t.title])));

	onMount(() => {
		const unsubscribe = client.subscribe((next) => (tenzo = next));
		client.connect();
		return () => {
			unsubscribe();
			client.close();
		};
	});

	async function answer(item: TenzoState['items'][number]) {
		const suggested = suggestedAnswer(item);
		if (!suggested) return;
		failure = null;
		try {
			await client.command({ type: 'item.answer', itemId: item.id, answer: suggested });
		} catch (error) {
			failure = error instanceof Error ? error.message : String(error);
		}
	}
</script>

<main class="mx-auto flex min-h-dvh max-w-xl flex-col gap-8 px-4 py-10 text-neutral-200">
	<header class="flex items-center gap-3">
		<img src={mark} alt="Tenzo" class="size-8" />
		<p
			class="flex items-center gap-2 text-sm text-neutral-500"
			data-testid="connection"
			data-state={tenzo.connection.state}
			data-synced={tenzo.synced}
			aria-live="polite"
		>
			<span
				class={[
					'size-1.5 rounded-full',
					tone === 'live' && 'bg-emerald-500',
					tone === 'waiting' && 'animate-pulse bg-neutral-500',
					tone === 'off' && 'bg-neutral-700'
				]}
			></span>
			{connectionLabel(tenzo.connection)}
		</p>
	</header>

	<div class={['flex flex-col gap-8', !tenzo.synced && 'opacity-50']}>
		<section class="flex flex-col gap-3">
			<h2 class="text-xs tracking-widest text-neutral-500 uppercase">Needs you</h2>
			<ul class="flex flex-col gap-3" data-testid="items">
				{#each tenzo.items as item (item.id)}
					<li class="flex flex-col gap-1" data-testid="item" data-id={item.id}>
						<span class="text-xs text-neutral-500">{threadTitle.get(item.threadId) ?? ''}</span>
						<span>{item.ask}</span>
						{#if suggestedAnswer(item)}
							<button
								class="self-start rounded bg-[#D97757] px-3 py-1 text-sm text-black"
								onclick={() => answer(item)}
								data-testid="answer"
							>
								{item.options.find((o) => o.value === item.suggested)?.label ?? item.suggested}
							</button>
						{/if}
					</li>
				{:else}
					<li class="text-sm text-neutral-600">Nothing.</li>
				{/each}
			</ul>
			{#if failure}
				<p class="text-sm text-red-400" role="alert">{failure}</p>
			{/if}
		</section>

		<section class="flex flex-col gap-3">
			<h2 class="text-xs tracking-widest text-neutral-500 uppercase">Threads</h2>
			<ul class="flex flex-col gap-1" data-testid="threads">
				{#each tenzo.threads as thread (thread.id)}
					<li class="flex justify-between gap-4 text-sm" data-testid="thread" data-id={thread.id}>
						<span class="truncate">{thread.title}</span>
						<span class="shrink-0 text-neutral-500">{thread.activity}</span>
					</li>
				{:else}
					<li class="text-sm text-neutral-600">None.</li>
				{/each}
			</ul>
		</section>
	</div>
</main>
