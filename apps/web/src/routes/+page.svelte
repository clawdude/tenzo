<script lang="ts">
	import { type ItemAnswer, liveOriginFor, type QueueItem } from '@tenzo/client-runtime';
	import { onMount } from 'svelte';
	import AllClear from '#lib/AllClear.svelte';
	import Card from '#lib/Card.svelte';
	import type { Failure } from '#lib/answering.ts';
	import { forward, lift } from '#lib/motion.ts';
	import { MAX_EDGES, pileEdges, pileOf } from '#lib/pass.ts';
	import { connectionLabel } from '#lib/status.ts';
	import { command, tenzo } from '#lib/tenzo.svelte.ts';
	import { type Fit, watchViewport } from '#lib/viewport.ts';

	// The Pass: the current item on top of the pile, nothing else competing with it.
	const live = $derived(tenzo.state);
	/** Items answered here whose card is lifting away while the daemon confirms. */
	let leaving = $state.raw<ReadonlySet<string>>(new Set());
	let failure = $state.raw<(Failure & { itemId: string }) | null>(null);
	/** Where the Pass goes while the keyboard is up; null: the whole window. */
	let fit = $state.raw<Fit | null>(null);
	let now = $state(Date.now());

	const pile = $derived(pileOf(live.items, leaving));
	const current = $derived(pile[0]);
	const edges = $derived(pileEdges(pile.length));
	const titles = $derived(new Map(live.threads.map((t) => [t.id, t.title])));
	/** Threads' live apps: Tenzo's live origin as this browser reaches it (live.ts). */
	const liveOrigin = $derived(liveOriginFor(location, live.live));
	const working = $derived(live.threads.filter((t) => t.working && t.openItems === 0));
	/** Darker the further back, from the mock-up. */
	const SHADES = ['#19191B', '#151517', '#121214', '#0F0F11'];
	const edgeDepths = $derived(Array.from({ length: edges }, (_, i) => edges - i));

	// Back after a drop: an earlier "not connected" no longer holds.
	let wasOnline = tenzo.online;
	$effect(() => {
		if (tenzo.online && !wasOnline) failure = null;
		wasOnline = tenzo.online;
	});

	onMount(() => {
		const tick = setInterval(() => (now = Date.now()), 30_000);
		const unwatch = watchViewport((next) => (fit = next));
		return () => {
			unwatch();
			clearInterval(tick);
		};
	});

	/**
	 * Sends an answer. The card lifts away at once and the next one is already there; if the
	 * daemon says no or the connection drops, the card comes back saying why. Returns whether the
	 * answer went out (not while offline: nothing is queued, the card just stays).
	 */
	function answer(item: QueueItem, answer: ItemAnswer): boolean {
		if (!tenzo.online) {
			failure = {
				itemId: item.id,
				message: "Not connected to Tenzo. Try again once it's back.",
				refused: false
			};
			return false;
		}
		failure = null;
		leaving = new Set([...leaving, item.id]);
		command({ type: 'item.answer', itemId: item.id, answer })
			.catch((error: unknown) => {
				failure = {
					itemId: item.id,
					message: error instanceof Error ? error.message : String(error),
					refused: true
				};
			})
			.finally(() => {
				const rest = new Set(leaving);
				rest.delete(item.id);
				leaving = rest;
			});
		return true;
	}
</script>

<main
	class={['fixed inset-x-0 flex flex-col overflow-hidden bg-black text-ink', !fit && 'inset-y-0']}
	style:top={fit ? `${fit.top}px` : null}
	style:height={fit ? `${fit.height}px` : null}
	data-compact={fit?.compact ?? false}
>
	<div
		class="relative mx-auto flex h-full max-h-[920px] w-full max-w-[440px] flex-col pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:my-auto sm:pt-6 sm:pb-6"
	>
		<header class={['mt-2 h-10 shrink-0 items-center justify-between gap-4 px-5', fit ? 'hidden' : 'flex']}>
			<p
				class="truncate text-[13px] text-faint"
				data-testid="connection"
				data-state={live.connection.state}
				data-synced={live.synced}
				aria-live="polite"
			>
				{#if !tenzo.online}{connectionLabel(live.connection)}{/if}
			</p>
			<nav class="flex shrink-0 gap-2">
				<a
					href="/new"
					aria-label="New thread"
					class="opt flex size-10 items-center justify-center rounded-full bg-card"
					data-testid="new"
				>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14"></path></svg>
				</a>
				<a
					href="/threads"
					aria-label="Threads"
					class="opt flex size-10 items-center justify-center rounded-full bg-card"
					data-testid="threads"
				>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h10"></path></svg>
				</a>
			</nav>
		</header>

		<section
			class={[
				'relative mx-4 grow transition-opacity',
				fit ? 'mt-3 mb-3' : 'mt-[52px] mb-4',
				tenzo.seen && !live.synced
					? 'opacity-45 delay-500 duration-300'
					: 'opacity-100 delay-0 duration-200'
			]}
			aria-label="The Pass"
			data-testid="pass"
		>
			{#each edgeDepths as depth (depth)}
				<div
					class="absolute inset-0 origin-top rounded-[28px] shadow-[inset_0_-2px_0_rgba(255,255,255,.04)] transition-transform duration-[380ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none"
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
						failure={failure?.itemId === item.id ? failure : null}
						compact={fit?.compact ?? false}
						{liveOrigin}
						onanswer={(a) => answer(item, a)}
					/>
				</div>
			{/each}

			{#if tenzo.seen && !current}
				<AllClear {working} {now} />
			{/if}
		</section>
	</div>
</main>
