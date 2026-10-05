<script lang="ts">
	import { type ItemAnswer, liveOriginFor, type QueueItem } from '@tenzo/client-runtime';
	import { onMount } from 'svelte';
	import AllClear from '#lib/AllClear.svelte';
	import Card from '#lib/Card.svelte';
	import SnoozeToast from '#lib/SnoozeToast.svelte';
	import type { Failure } from '#lib/answering.ts';
	import { automationsSummary } from '#lib/automations.ts';
	import { meanwhileOf } from '#lib/meanwhile.ts';
	import { arrive, type Departure, leave } from '#lib/motion.ts';
	import { MAX_EDGES, pileEdges, pileOf, snoozedLabel } from '#lib/pass.ts';
	import { connectionLabel } from '#lib/status.ts';
	import { swipeable } from '#lib/swipeable.ts';
	import { command, tenzo } from '#lib/tenzo.svelte.ts';
	import { type Fit, watchViewport } from '#lib/viewport.ts';

	// The Pass: the current item on top of the pile, nothing else competing with it.
	const live = $derived(tenzo.state);
	const OFFLINE = "Not connected to Tenzo. Try again once it's back.";
	/** How long the snooze toast offers Undo. */
	const TOAST_MS = 5_000;
	/** Items answered or swiped away here whose card is leaving while the daemon confirms. */
	let leaving = $state.raw<ReadonlySet<string>>(new Set());
	let failure = $state.raw<(Failure & { itemId: string }) | null>(null);
	/** Where the Pass goes while the keyboard is up; null: the whole window. */
	let fit = $state.raw<Fit | null>(null);
	let now = $state(Date.now());
	/** The card in front: it stays there while others arrive behind it (pass.ts). */
	let front = $state<string | null>(null);
	/** A card being brought back to the front: by Undo, a tap under Meanwhile, a refusal. */
	let bringing = $state<string | null>(null);
	/** How each card leaving goes (lifted, or flung aside), and which side a returning one comes from. */
	const departures = new Map<string, Departure>();
	const arrivals = new Map<string, -1 | 1>();
	/** The top card's offset while a finger drags it aside. */
	let drag = $state(0);
	let dragging = $state(false);
	let toast = $state.raw<{ itemId: string; text: string; undo: boolean; side: -1 | 1 } | null>(
		null
	);
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	const pile = $derived(pileOf(live.items, { leaving, front: bringing ?? front }));
	const current = $derived(pile[0]);
	const edges = $derived(pileEdges(pile.length));
	const titles = $derived(new Map(live.threads.map((t) => [t.id, t.title])));
	/** Threads' live apps: Tenzo's live origin as this browser reaches it (live.ts). */
	const liveOrigin = $derived(liveOriginFor(location, live.live));
	/** The daemon's clock, for counting down to the times it sets: this device's may be off. */
	const daemonNow = $derived(now + live.connection.clockOffset);
	const meanwhile = $derived(meanwhileOf(live.threads, live.items, daemonNow));
	const automations = $derived(
		automationsSummary(
			live.automations,
			live.automationsPaused,
			daemonNow,
			live.automationProblems.length
		)
	);
	/** Darker the further back, from the mock-up. */
	const SHADES = ['#19191B', '#151517', '#121214', '#0F0F11'];
	const edgeDepths = $derived(Array.from({ length: edges }, (_, i) => edges - i));

	// The card on top stays on top until it leaves; one being brought back takes its place.
	$effect(() => {
		front = current?.id ?? null;
		const back = bringing;
		if (back === null) return;
		if (current?.id === back || !live.items.some((i) => i.id === back)) bringing = null;
	});

	// Nothing to undo once the item is gone (answered or archived elsewhere).
	$effect(() => {
		const shown = toast;
		if (shown && !live.items.some((i) => i.id === shown.itemId)) toast = null;
	});

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
			clearTimeout(toastTimer);
		};
	});

	function without(set: ReadonlySet<string>, id: string): ReadonlySet<string> {
		const rest = new Set(set);
		rest.delete(id);
		return rest;
	}

	function showToast(next: NonNullable<typeof toast>) {
		clearTimeout(toastTimer);
		toast = next;
		toastTimer = setTimeout(() => (toast = null), TOAST_MS);
	}

	/**
	 * Swiped aside: the card flies off the way it went and the next one is there; the daemon
	 * snoozes it on every device, and a toast offers Undo. Refused or offline, it comes back.
	 */
	function snooze(item: QueueItem, side: -1 | 1, from: number) {
		dragging = false;
		drag = 0;
		if (!tenzo.online) {
			failure = { itemId: item.id, message: OFFLINE, refused: false };
			return;
		}
		failure = null;
		departures.set(item.id, { kind: 'fling', direction: side, from });
		leaving = new Set([...leaving, item.id]);
		const title = titles.get(item.threadId) ?? '';
		command({ type: 'item.snooze', itemId: item.id })
			.then(({ item: snoozed }) => {
				if (!snoozed.snoozedUntil) return;
				showToast({
					itemId: item.id,
					text: snoozedLabel(title, snoozed.snoozedUntil, Date.now() + live.connection.clockOffset),
					undo: true,
					side
				});
			})
			.catch((error: unknown) => {
				arrivals.set(item.id, side);
				bringing = item.id;
				failure = {
					itemId: item.id,
					message: error instanceof Error ? error.message : String(error),
					refused: false
				};
			})
			.finally(() => {
				// The card has started leaving by now; it read how when it did.
				departures.delete(item.id);
				leaving = without(leaving, item.id);
			});
	}

	/** Brings a snoozed item back to the front now, coming in from `side` if it was swiped. */
	function wake(itemId: string, side: -1 | 1 | null = null) {
		if (!tenzo.online) {
			if (toast) showToast({ ...toast, text: OFFLINE, undo: false });
			return;
		}
		if (side === null) arrivals.delete(itemId);
		else arrivals.set(itemId, side);
		bringing = itemId;
		command({ type: 'item.unsnooze', itemId }).catch((error: unknown) => {
			if (bringing === itemId) bringing = null;
			const message = error instanceof Error ? error.message : String(error);
			showToast({ itemId, text: `Couldn't bring it back: ${message}`, undo: false, side: 1 });
		});
	}

	function undo() {
		const shown = toast;
		if (!shown) return;
		clearTimeout(toastTimer);
		toast = null;
		wake(shown.itemId, shown.side);
	}

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
		arrivals.delete(item.id);
		leaving = new Set([...leaving, item.id]);
		command({ type: 'item.answer', itemId: item.id, answer })
			.catch((error: unknown) => {
				bringing = item.id;
				failure = {
					itemId: item.id,
					message: error instanceof Error ? error.message : String(error),
					refused: true
				};
			})
			.finally(() => {
				leaving = without(leaving, item.id);
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
				<!-- Swipe it aside (left or right) to snooze it; its text still scrolls up and down. -->
				<div
					class={[
						'absolute inset-0 touch-pan-y',
						// Follows the finger at once; springs back when let go, unless motion is reduced.
						!dragging &&
							'transition-transform duration-[380ms] ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none'
					]}
					style:transform={drag !== 0 ? `translateX(${drag}px) rotate(${drag / 22}deg)` : null}
					in:arrive={arrivals.get(item.id) ?? null}
					out:leave={departures.get(item.id) ?? null}
					use:swipeable={{
						enabled: !leaving.has(item.id),
						ondrag: (dx) => {
							dragging = true;
							drag = dx;
						},
						onsettle: () => {
							dragging = false;
							drag = 0;
						},
						onswipe: (side, dx) => snooze(item, side, dx)
					}}
					data-testid="top"
				>
					<Card
						{item}
						thread={titles.get(item.threadId) ?? ''}
						now={daemonNow}
						failure={failure?.itemId === item.id ? failure : null}
						compact={fit?.compact ?? false}
						{liveOrigin}
						threadView={live.threads.find((t) => t.id === item.threadId)}
						onanswer={(a) => answer(item, a)}
					/>
				</div>
			{/each}

			{#if tenzo.seen && !current}
				<AllClear {meanwhile} {automations} onwake={(id) => wake(id)} />
			{/if}
		</section>

		{#if toast}
			<SnoozeToast text={toast.text} onundo={toast.undo ? undo : null} />
		{/if}
	</div>
</main>
