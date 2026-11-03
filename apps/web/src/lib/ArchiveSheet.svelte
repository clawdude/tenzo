<script lang="ts">
	import type { ThreadView } from '@tenzo/client-runtime';
	import { onMount } from 'svelte';
	import { fade, fly } from 'svelte/transition';
	import { archiveSheet, refusedForChanges } from '#lib/archive.ts';
	import { command, tenzo } from '#lib/tenzo.svelte.ts';

	// Archive by hand (the mock-up's replies/4): always asks first. Its agent stops, its worktree
	// goes, its branch stays; uncommitted files, counted by the daemon, are said and need
	// Archive anyway. Keep it cancels.
	interface Props {
		thread: ThreadView;
		onclose: () => void;
		/** It's archived: the daemon said so. */
		onarchived?: (thread: ThreadView) => void;
	}
	let { thread, onclose, onarchived }: Props = $props();

	/** Files with uncommitted changes, as the daemon counted them; null until it has. */
	let files = $state<number | null>(null);
	let busy = $state(false);
	let error = $state<string | null>(null);
	const view = $derived(archiveSheet(files));
	const reduce =
		typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

	async function count() {
		try {
			files = (await command({ type: 'thread.uncommitted', threadId: thread.id })).files;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	onMount(() => void count());

	async function archive() {
		if (busy) return;
		if (!tenzo.online) {
			error = "Not connected to Tenzo. Try again once it's back.";
			return;
		}
		busy = true;
		error = null;
		try {
			const { thread: archived } = await command({
				type: 'thread.archive',
				threadId: thread.id,
				...(view.force ? { force: true } : {})
			});
			onarchived?.(archived);
			onclose();
		} catch (e) {
			const message = e instanceof Error ? e.message : String(e);
			// Something was written since the count: count again, and the sheet warns.
			if (refusedForChanges(message)) await count();
			else error = message;
		} finally {
			busy = false;
		}
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key === 'Escape' && !busy) onclose();
	}
</script>

<svelte:window {onkeydown} />

<div
	class="fixed inset-0 z-50 flex items-end justify-center bg-black/70 px-3 pb-[calc(env(safe-area-inset-bottom)+12px)]"
	transition:fade={{ duration: reduce ? 0 : 160 }}
	data-testid="archive-sheet"
>
	<button type="button" aria-label="Keep it" class="absolute inset-0 cursor-default" onclick={() => !busy && onclose()}></button>
	<div
		class="relative w-full max-w-[440px] rounded-[28px] bg-card px-6 pt-6 pb-4"
		role="dialog"
		aria-modal="true"
		aria-labelledby="archive-title"
		transition:fly={{ y: reduce ? 0 : 40, duration: reduce ? 0 : 220 }}
	>
		<h2 id="archive-title" class="text-[24px] leading-[1.2] font-bold tracking-[-0.02em]">Archive this thread?</h2>
		<p class="mt-3 text-[17px] leading-[1.45] text-ink-soft">
			Its agent stops and its worktree is removed. The branch
			<code class="rounded-md bg-fill px-1.5 py-0.5 font-mono text-[15px] break-all">{thread.branch}</code>
			is kept.
		</p>
		{#if view.warning}
			<p class="mt-3 text-[17px] leading-[1.45] text-fail" data-testid="archive-warning">{view.warning}</p>
		{/if}
		{#if error}
			<p class="mt-3 text-[15px] leading-snug text-clay" role="alert" data-testid="archive-error">{error}</p>
		{/if}
		<button
			type="button"
			class="opt mt-5 flex min-h-14 w-full items-center rounded-[18px] bg-clay px-5 text-left text-[17px] font-semibold text-on-clay disabled:opacity-60"
			onclick={archive}
			disabled={busy}
			data-testid="archive-confirm">{view.confirm}</button
		>
		<button
			type="button"
			class="mt-1 min-h-11 w-full text-[15px] text-mute"
			onclick={onclose}
			disabled={busy}
			data-testid="archive-keep">Keep it</button
		>
	</div>
</div>
