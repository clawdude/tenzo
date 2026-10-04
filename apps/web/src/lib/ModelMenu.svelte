<script lang="ts">
	import type { ThinkingLevel, ThreadView } from '@tenzo/client-runtime';
	import { MODEL_PICKS, overrideLabel, setModelCommand, THINKING_LEVELS } from '#lib/model.ts';
	import { command } from '#lib/tenzo.svelte.ts';

	// The thread's "⋯" (PRODUCT.md §2.9): its own model, over its project's config. Settings stay
	// out of the way: a small button, and a sheet only when you open it.
	interface Props {
		thread: ThreadView;
		/** What its session said it runs on, last; null before it started. */
		running: string | null;
	}
	let { thread, running }: Props = $props();

	let open = $state(false);
	let model = $state('');
	let thinking = $state<ThinkingLevel | null>(null);
	let saving = $state(false);
	let error = $state<string | null>(null);

	function show() {
		model = thread.model ?? '';
		thinking = thread.thinking;
		error = null;
		open = true;
	}

	async function save() {
		if (saving) return;
		saving = true;
		error = null;
		try {
			await command(setModelCommand(thread.id, model, thinking));
			open = false;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}

	function onkeydown(event: KeyboardEvent) {
		if (open && event.key === 'Escape') open = false;
	}
</script>

<svelte:window {onkeydown} />

<button
	type="button"
	aria-label="Thread settings"
	class="opt flex size-11 items-center justify-center rounded-full text-mute"
	onclick={show}
	disabled={thread.status !== 'active'}
	data-testid="thread-menu"
>
	<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="19" cy="12" r="2"></circle></svg>
</button>

{#if open}
	<div class="fixed inset-0 z-50 flex items-end justify-center bg-black/60" data-testid="model-sheet">
		<button type="button" aria-label="Close" class="absolute inset-0 cursor-default" onclick={() => (open = false)}></button>
		<div
			class="relative w-full max-w-[440px] rounded-t-[24px] bg-card px-5 pt-5 pb-[calc(env(safe-area-inset-bottom)+20px)]"
			role="dialog"
			aria-modal="true"
			aria-label="Model"
		>
			<p class="text-[13px] font-semibold tracking-[0.06em] text-mute uppercase">Model</p>
			<p class="mt-1 text-[14px] text-mute" data-testid="model-now">
				{overrideLabel(thread)}{running ? ` · running ${running}` : ''}
			</p>

			<div class="mt-4 flex flex-wrap gap-2">
				<button
					type="button"
					class={['opt min-h-9 rounded-full px-3.5 text-[15px]', model.trim() === '' ? 'bg-ink text-black' : 'bg-fill text-ink']}
					onclick={() => (model = '')}
					data-testid="model-default">Project default</button
				>
				{#each MODEL_PICKS as pick (pick)}
					<button
						type="button"
						class={['opt min-h-9 rounded-full px-3.5 text-[15px]', model.trim() === pick ? 'bg-ink text-black' : 'bg-fill text-ink']}
						onclick={() => (model = pick)}
						data-testid={`model-${pick}`}>{pick}</button
					>
				{/each}
			</div>
			<label class="mt-3 block">
				<span class="sr-only">Another model</span>
				<input
					bind:value={model}
					placeholder="or a model name"
					autocapitalize="off"
					autocomplete="off"
					spellcheck="false"
					class="min-h-11 w-full rounded-[12px] bg-fill px-3.5 text-[16px] text-ink outline-none placeholder:text-faint"
					data-testid="model-input"
				/>
			</label>

			<p class="mt-5 text-[13px] font-semibold tracking-[0.06em] text-mute uppercase">Thinking</p>
			<div class="mt-2 flex flex-wrap gap-2">
				{#each [null, ...THINKING_LEVELS] as level (level ?? 'default')}
					<button
						type="button"
						class={['opt min-h-9 rounded-full px-3.5 text-[15px]', thinking === level ? 'bg-ink text-black' : 'bg-fill text-ink']}
						onclick={() => (thinking = level)}
						data-testid={`thinking-${level ?? 'default'}`}>{level ?? 'Default'}</button
					>
				{/each}
			</div>

			{#if error}
				<p class="mt-4 text-[14px] leading-snug text-clay" role="alert">{error}</p>
			{/if}
			<button
				type="button"
				class="opt mt-5 flex min-h-14 w-full items-center justify-center rounded-[18px] bg-clay px-4 text-[17px] font-semibold text-on-clay disabled:opacity-50"
				onclick={save}
				disabled={saving}
				data-testid="model-save"
			>
				Save
			</button>
			<p class="mt-3 text-center text-[13px] leading-snug text-faint">
				For this thread only, from now on. A running session switches at once.
			</p>
		</div>
	</div>
{/if}
