<script lang="ts">
	import { fade } from 'svelte/transition';
	import type { MeanwhileRow } from '#lib/meanwhile.ts';

	interface Props {
		/** Threads at work and snoozed items, while nothing needs you (meanwhile.ts). */
		meanwhile: readonly MeanwhileRow[];
		/** Brings a snoozed item back now. */
		onwake: (itemId: string) => void;
	}
	let { meanwhile, onwake }: Props = $props();
</script>

<!-- Nothing needs you: the card becomes the way to start something. -->
<div
	class="absolute inset-0 flex flex-col justify-center gap-7 px-2 pb-10"
	in:fade={{ duration: 300, delay: 120 }}
	data-testid="all-clear"
>
	<a
		href="/new"
		class="opt flex min-h-[150px] flex-col gap-2.5 rounded-[28px] bg-card p-[22px] shadow-[0_24px_60px_rgba(0,0,0,.6)]"
		data-testid="ask-new"
	>
		<p class="text-[26px] leading-[1.15] font-bold tracking-[-0.02em] text-mute">
			What do you want to do?
		</p>
		<span class="grow"></span>
		<span class="flex items-center justify-between gap-3">
			<span class="text-[14px] text-faint">Nothing needs you.</span>
			<span
				class="flex size-10 shrink-0 items-center justify-center rounded-full bg-fill text-ink"
				aria-hidden="true"
			>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"></path></svg>
			</span>
		</span>
	</a>

	{#if meanwhile.length > 0}
		<section class="flex flex-col gap-0.5 px-2" data-testid="meanwhile">
			<h2 class="mb-2 text-[13px] font-semibold tracking-[0.06em] text-faint uppercase">Meanwhile</h2>
			{#each meanwhile as row (row.key)}
				{#if row.kind === 'working'}
					<div class="flex min-h-12 items-center gap-3" data-testid="working">
						<span class="size-2 shrink-0 rounded-full bg-working"></span>
						<span class="grow truncate text-[17px]">{row.title}</span>
						<span class="shrink-0 text-[15px] text-faint">{row.age}</span>
					</div>
				{:else}
					<!-- Snoozed: back by itself when the time is up, or now with a tap. -->
					<button
						type="button"
						class="opt flex min-h-12 w-full items-center gap-3 text-left"
						aria-label={`${row.title}, snoozed, ${row.left}. Bring it back now`}
						onclick={() => onwake(row.itemId)}
						data-testid="snoozed"
						data-id={row.itemId}
					>
						<span class="size-2 shrink-0 rounded-full bg-fill-strong"></span>
						<span class="grow truncate text-[17px] text-ink-soft">{row.title} · snoozed</span>
						<span class="shrink-0 text-[15px] text-faint">{row.left}</span>
					</button>
				{/if}
			{/each}
		</section>
	{/if}
</div>
