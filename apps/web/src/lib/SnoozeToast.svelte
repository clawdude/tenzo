<script lang="ts">
	import { fly } from 'svelte/transition';

	interface Props {
		/** "Refresh tokens · back in 15 min", or why Undo didn't work. */
		text: string;
		/** Undo is offered until it has been tapped. */
		onundo: (() => void) | null;
	}
	let { text, onundo }: Props = $props();
</script>

<!-- Says what the swipe did, and takes it back. -->
<div
	class="absolute inset-x-4 bottom-[calc(env(safe-area-inset-bottom)+20px)] z-10 flex min-h-14 items-center gap-3 rounded-[18px] bg-fill pr-2 pl-[18px] shadow-[0_12px_40px_rgba(0,0,0,.7)]"
	role="status"
	in:fly={{ y: 24, duration: 220 }}
	out:fly={{ y: 24, duration: 180 }}
	data-testid="toast"
>
	<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="shrink-0 text-ink-soft" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path></svg>
	<span class="grow truncate text-[15px]">{text}</span>
	{#if onundo}
		<button
			type="button"
			class="opt min-h-11 shrink-0 px-3 text-[15px] font-semibold text-clay"
			onclick={onundo}
			data-testid="undo">Undo</button
		>
	{/if}
</div>
