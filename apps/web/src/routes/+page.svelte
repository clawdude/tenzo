<script lang="ts">
	import {
		type ItemAnswer,
		type QueueItem,
		TenzoClient,
		type TenzoState
	} from '@tenzo/client-runtime';
	import { onMount } from 'svelte';
	import AllClear from '#lib/AllClear.svelte';
	import Card from '#lib/Card.svelte';
	import { forward, lift } from '#lib/motion.ts';
	import { MAX_EDGES, pileEdges, pileOf } from '#lib/pass.ts';
	import { connectionLabel, daemonSocketUrl } from '#lib/status.ts';

	// The Pass: the current item on top of the pile, nothing else competing with it.
	const client = new TenzoClient({ url: daemonSocketUrl(location) });
	let tenzo = $state.raw<TenzoState>(client.state);
	/** The daemon's data has arrived at least once; until then an empty pile means nothing. */
	let seen = $state(false);
	/** Items answered here whose card is lifting away while the daemon confirms. */
	let leaving = $state.raw<ReadonlySet<string>>(new Set());
	let failure = $state.raw<{ itemId: string; message: string } | null>(null);
	let now = $state(Date.now());

	const pile = $derived(pileOf(tenzo.items, leaving));
	const current = $derived(pile[0]);
	const edges = $derived(pileEdges(pile.length));
	const titles = $derived(new Map(tenzo.threads.map((t) => [t.id, t.title])));
	const working = $derived(tenzo.threads.filter((t) => t.working && t.openItems === 0));
	const online = $derived(tenzo.connection.state === 'connected');
	/** Darker the further back, from the mock-up. */
	const SHADES = ['#19191B', '#151517', '#121214', '#0F0F11'];
	const edgeDepths = $derived(Array.from({ length: edges }, (_, i) => edges - i));

	onMount(() => {
		const unsubscribe = client.subscribe((next) => {
			// Back after a drop: an earlier "not connected" no longer holds.
			if (next.connection.state === 'connected' && tenzo.connection.state !== 'connected') {
				failure = null;
			}
			if (next.synced) seen = true;
			tenzo = next;
		});
		client.connect();
		const tick = setInterval(() => (now = Date.now()), 30_000);
		return () => {
			clearInterval(tick);
			unsubscribe();
			client.close();
		};
	});

	/**
	 * Sends an answer. The card lifts away at once and the next one is already there; if the
	 * daemon says no or the connection drops, the card comes back saying why. Returns whether the
	 * answer went out (not while offline: nothing is queued, the card just stays).
	 */
	function answer(item: QueueItem, answer: ItemAnswer): boolean {
		if (tenzo.connection.state !== 'connected') {
			failure = { itemId: item.id, message: "Not connected to Tenzo. Try again once it's back." };
			return false;
		}
		failure = null;
		leaving = new Set([...leaving, item.id]);
		client
			.command({ type: 'item.answer', itemId: item.id, answer })
			.catch((error: unknown) => {
				failure = { itemId: item.id, message: error instanceof Error ? error.message : String(error) };
			})
			.finally(() => {
				const rest = new Set(leaving);
				rest.delete(item.id);
				leaving = rest;
			});
		return true;
	}
</script>

<main class="fixed inset-0 flex flex-col overflow-hidden bg-black text-ink">
	<div
		class="relative mx-auto flex h-full max-h-[920px] w-full max-w-[440px] flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:my-auto sm:pt-6 sm:pb-6"
	>
		<header class="mt-2 flex h-10 shrink-0 items-center justify-between px-5">
			<p
				class="text-[13px] text-faint"
				data-testid="connection"
				data-state={tenzo.connection.state}
				data-synced={tenzo.synced}
				aria-live="polite"
			>
				{#if !online}{connectionLabel(tenzo.connection)}{/if}
			</p>
			<!-- New thread (+) and Threads (#9) go here, top right. -->
		</header>

		<section
			class={[
				'relative mx-4 mt-[52px] mb-4 grow transition-opacity',
				seen && !tenzo.synced
					? 'opacity-45 delay-500 duration-300'
					: 'opacity-100 delay-0 duration-200'
			]}
			aria-label="The Pass"
			data-testid="pass"
		>
			{#each edgeDepths as depth (depth)}
				<div
					class="absolute inset-0 origin-top rounded-[28px] shadow-[inset_0_-2px_0_rgba(255,255,255,.04)] transition-transform duration-[380ms] ease-[cubic-bezier(.2,.8,.2,1)]"
					style:background={SHADES[Math.min(depth, MAX_EDGES) - 1]}
					style:transform={`translateY(-${11 * depth}px) scale(${1 - 0.035 * depth})`}
					data-testid="edge"
				></div>
			{/each}

			{#each current ? [current] : [] as item (item.id)}
				<div class="absolute inset-0" in:forward out:lift>
					<Card
						{item}
						thread={titles.get(item.threadId) ?? ''}
						{now}
						error={failure?.itemId === item.id ? failure.message : null}
						onanswer={(a) => answer(item, a)}
					/>
				</div>
			{/each}

			{#if seen && !current}
				<AllClear {working} {now} />
			{/if}
		</section>
	</div>
</main>
