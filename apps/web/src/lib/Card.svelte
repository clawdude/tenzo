<script lang="ts">
	import type { ItemAnswer, QueueItem } from '@tenzo/client-runtime';
	import { onDestroy } from 'svelte';
	import { type Failure, fresh, isNewRefusal, refused, tap, unsent } from '#lib/answering.ts';
	import { ageLabel, othersLabel, type Pick, stepsOf } from '#lib/pass.ts';
	import { canDictate, dictate } from '#lib/speech.ts';

	interface Props {
		item: QueueItem;
		/** The thread's name, for the small caps at the top. */
		thread: string;
		now: number;
		failure: Failure | null;
		/** Little room (the keyboard is up): the question and the answers only. */
		compact?: boolean;
		/** Sends the answer; false when it couldn't go (offline), and the card stays. */
		onanswer: (answer: ItemAnswer) => boolean;
	}
	let { item, thread, now, failure, compact = false, onanswer }: Props = $props();

	const steps = $derived(stepsOf(item));
	// Which question the card is on, whether its answer has gone, and which taps to ignore.
	let answering = $state.raw(fresh(performance.now()));
	const step = $derived(steps[answering.picks.length]);
	const answered = $derived(
		answering.picks.map((p, i) => ({
			ask: steps[i]?.ask ?? '',
			said: 'text' in p ? p.text : p.choice.label
		}))
	);
	let showOthers = $state(false);
	let more = $state(false);
	let text = $state('');
	let stopListening = $state.raw<(() => void) | null>(null);
	let dictation = $state(canDictate());
	const fieldId = $derived(`answer-${item.id}`);
	let contextBox = $state(0);
	let contextHeight = $state(0);

	// Refused while the card was still lifting, Svelte brings this same card back: start over,
	// once per refusal. The effect also runs when the item changes; that is not a new refusal.
	let handled: Failure | null = null;
	$effect(() => {
		if (!isNewRefusal(failure, handled)) return;
		handled = failure;
		answering = refused(performance.now());
	});

	function pick(chosen: Pick) {
		const before = answering.picks.length;
		const { state, answer } = tap(item, answering, chosen, performance.now());
		if (state === answering) return; // sent already, or it has only just appeared
		stopListening?.();
		answering = state;
		if (state.picks.length > before) {
			showOthers = false;
			text = '';
		}
		if (answer && !onanswer(answer)) answering = unsent(state);
	}

	function submit(event: SubmitEvent) {
		event.preventDefault();
		const words = text.trim();
		if (words) pick({ text: words });
	}

	function toggleMic() {
		if (stopListening) {
			stopListening();
			return;
		}
		const before = text.trim();
		stopListening = dictate(
			(heard) => (text = before ? `${before} ${heard}` : heard),
			() => {
				stopListening = null;
				// A home-screen app may not be allowed to listen: then the mic goes for good.
				dictation = canDictate();
			}
		);
	}

	onDestroy(() => stopListening?.());
</script>

<article
	class="absolute inset-0 flex flex-col overflow-hidden rounded-[28px] bg-card shadow-[0_24px_60px_rgba(0,0,0,.6)]"
	data-testid="card"
	data-id={item.id}
	data-kind={item.kind}
>
	<header class="flex shrink-0 items-center justify-between gap-4 px-[22px] pt-5">
		<span
			class="truncate text-[13px] font-semibold tracking-[0.06em] text-clay uppercase"
			data-testid="thread">{thread}</span
		>
		<span class="shrink-0 text-[13px] text-faint">{ageLabel(item.createdAt, now)}</span>
	</header>

	<!-- Text scrolls in here and fades out above the answers, which never move. -->
	<div
		class="scroll min-h-0 grow overflow-y-auto px-[22px] pt-4 pb-6 [mask-image:linear-gradient(to_bottom,#000_calc(100%-24px),transparent)]"
	>
		{#if item.context && !compact}
			<!--
				Three lines until More, one while the options are out. The end is what leads into the
				question (the daemon keeps the end too), so a long context shows its last lines,
				fading in at the top.
			-->
			<div
				class={[
					'mb-3.5 flex flex-col justify-end overflow-hidden',
					!more && (showOthers ? 'max-h-[calc(1.45*18px)]' : 'max-h-[calc(3*1.45*18px)]'),
					!more &&
						contextHeight > contextBox + 1 &&
						'[mask-image:linear-gradient(to_bottom,transparent,#000_1.2em)]'
				]}
				bind:clientHeight={contextBox}
			>
				<p
					class="shrink-0 text-[18px] leading-[1.45] text-ink-soft"
					bind:clientHeight={contextHeight}
					data-testid="context"
				>
					{item.context}
				</p>
			</div>
		{/if}
		{#each answered as a, i (i)}
			<p class="mb-2 text-[15px] leading-snug text-mute">
				{a.ask} <span class="text-ink-soft">{a.said}</span>
			</p>
		{/each}
		<h2 class="mb-4 text-[26px] leading-[1.18] font-bold tracking-[-0.02em]" data-testid="ask">
			{step?.ask ?? item.ask}
		</h2>
		{#if item.permission && !item.ask.includes(item.permission.detail)}
			<pre
				class="mb-4 rounded-2xl bg-fill px-4 py-3 font-mono text-[14px] leading-snug break-words whitespace-pre-wrap text-ink-soft">{item
					.permission.detail}</pre>
		{/if}

		<button
			type="button"
			class="opt inline-flex min-h-9 items-center gap-1.5 rounded-full bg-fill pr-3.5 pl-3 text-[14px] font-medium"
			aria-expanded={more}
			onclick={() => (more = !more)}
			data-testid="more"
		>
			<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 11v6M12 7v.5"></path></svg>
			{more ? 'Less' : item.kind === 'permission' ? 'What exactly' : "Why it's asking"}
		</button>

		{#if more}
			<div class="mt-4 flex flex-col gap-3 text-[15px] leading-snug" data-testid="details">
				{#if item.permission}
					{#if item.permission.reason}
						<p class="text-ink-soft">{item.permission.reason}</p>
					{/if}
					<p class="text-mute">{item.permission.toolName}</p>
					<pre
						class="rounded-2xl bg-fill px-4 py-3 font-mono text-[13px] break-words whitespace-pre-wrap text-ink-soft">{JSON.stringify(
							item.permission.input,
							null,
							2
						)}</pre>
				{:else if step}
					{#each [step.suggested, ...step.others] as choice (choice?.value)}
						{#if choice}
							<div>
								<p class="font-semibold">{choice.label}</p>
								{#if choice.description}<p class="text-ink-soft">{choice.description}</p>{/if}
							</div>
						{/if}
					{/each}
				{/if}
			</div>
		{/if}
	</div>

	<div class="scroll flex max-h-[58%] shrink-0 flex-col gap-2.5 overflow-y-auto px-4 pt-3 pb-4">
		{#if failure}
			<p class="px-1 text-[14px] leading-snug text-clay" role="alert" data-testid="error">
				{failure.message}
			</p>
		{/if}

		{#if step && showOthers}
			{#each step.others as choice (choice.value)}
				<button
					type="button"
					class="opt flex min-h-[50px] w-full items-center rounded-2xl bg-fill px-4 py-3 text-left text-[16px] leading-[1.3] font-medium"
					onclick={() => pick({ choice })}
					data-testid="option">{choice.label}</button
				>
			{/each}
		{/if}

		{#if step?.suggested}
			{@const suggested = step.suggested}
			<button
				type="button"
				class="opt flex min-h-16 w-full flex-col items-start justify-center gap-[3px] rounded-[18px] bg-clay px-4 py-[13px] text-left text-on-clay"
				onclick={() => pick({ choice: suggested })}
				data-testid="suggested"
			>
				{#if step.recommended}
					<span class="text-[12px] font-semibold tracking-[0.06em] uppercase opacity-70">Suggested</span>
				{/if}
				<span class="text-[17px] leading-[1.3] font-semibold">{suggested.label}</span>
			</button>
		{/if}

		<form
			class="flex min-h-[52px] items-center gap-2 rounded-[18px] bg-fill py-1.5 pr-1.5 pl-4 outline-2 outline-offset-2 outline-transparent focus-within:outline-mute"
			onsubmit={submit}
		>
			<label for={fieldId} class="sr-only">Your answer</label>
			<input
				id={fieldId}
				type="text"
				bind:value={text}
				placeholder={step?.placeholder ?? "Or say what you'd prefer"}
				enterkeyhint="send"
				autocomplete="off"
				class="min-w-0 grow bg-transparent text-[16px] outline-none placeholder:text-faint"
				data-testid="free-text"
			/>
			{#if text.trim() && !stopListening}
				<button
					type="submit"
					aria-label="Send"
					class="opt flex size-10 shrink-0 items-center justify-center rounded-full bg-ink text-black"
					data-testid="send"
				>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"></path></svg>
				</button>
			{:else if dictation}
				<button
					type="button"
					aria-label={stopListening ? 'Stop dictating' : 'Dictate'}
					aria-pressed={stopListening !== null}
					class={[
						'opt flex size-10 shrink-0 items-center justify-center rounded-full',
						stopListening
							? 'animate-pulse bg-ink text-black motion-reduce:animate-none'
							: 'bg-fill-strong'
					]}
					onclick={toggleMic}
					data-testid="mic"
				>
					<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><path d="M12 18v3"></path></svg>
				</button>
			{/if}
		</form>

		{#if step && step.others.length > 0}
			<button
				type="button"
				class="min-h-9 text-[14px] text-mute"
				aria-expanded={showOthers}
				onclick={() => (showOthers = !showOthers)}
				data-testid="others">{othersLabel(step.others.length, showOthers)}</button
			>
		{/if}
	</div>
</article>
