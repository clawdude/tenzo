<script lang="ts">
	import type { ThreadView } from '@tenzo/client-runtime';
	import { onDestroy } from 'svelte';
	import { placeholderOf } from '#lib/composer.ts';
	import { canDictate, dictate } from '#lib/speech.ts';
	import { command, tenzo } from '#lib/tenzo.svelte.ts';

	// The thread page's message field (the mock-up's replies/3): a prompt for the thread, sent
	// with `thread.send`. While a turn runs it waits its turn in the daemon's queue.
	interface Props {
		thread: ThreadView;
		/** It went: what was sent, trimmed. */
		onsent: (text: string) => void;
	}
	let { thread, onsent }: Props = $props();

	let text = $state('');
	let sending = $state(false);
	let error = $state<string | null>(null);
	let stopListening = $state.raw<(() => void) | null>(null);
	let dictation = $state(canDictate());

	async function submit(event: SubmitEvent) {
		event.preventDefault();
		const words = text.trim();
		if (!words || sending) return;
		if (!tenzo.online) {
			error = "Not connected to Tenzo. Try again once it's back.";
			return;
		}
		stopListening?.();
		sending = true;
		error = null;
		try {
			await command({ type: 'thread.send', threadId: thread.id, prompt: words });
			text = '';
			onsent(words);
		} catch (e) {
			// A landed thread says why in the daemon's words: start a new thread for more work.
			error = e instanceof Error ? e.message : String(e);
		} finally {
			sending = false;
		}
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
				dictation = canDictate();
			}
		);
	}

	onDestroy(() => stopListening?.());
</script>

<div class="shrink-0 px-4 pt-3 pb-4">
	{#if error}
		<p class="mb-2 px-1 text-[14px] leading-snug text-clay" role="alert" data-testid="composer-error">{error}</p>
	{/if}
	<form
		class="flex min-h-[56px] items-center gap-2 rounded-[22px] bg-card py-1.5 pr-1.5 pl-4 outline-2 outline-offset-2 outline-transparent focus-within:outline-mute"
		onsubmit={submit}
		data-testid="composer"
	>
		<label for="message" class="sr-only">Message</label>
		<input
			id="message"
			type="text"
			bind:value={text}
			placeholder={placeholderOf(thread)}
			enterkeyhint="send"
			autocomplete="off"
			class="min-w-0 grow bg-transparent text-[16px] outline-none placeholder:text-faint"
			data-testid="message"
		/>
		{#if dictation}
			<button
				type="button"
				aria-label={stopListening ? 'Stop dictating' : 'Dictate'}
				aria-pressed={stopListening !== null}
				class={[
					'opt flex size-10 shrink-0 items-center justify-center rounded-full',
					stopListening ? 'animate-pulse bg-ink text-black motion-reduce:animate-none' : 'bg-fill-strong'
				]}
				onclick={toggleMic}
				data-testid="mic"
			>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"></rect><path d="M5 11a7 7 0 0 0 14 0"></path><path d="M12 18v3"></path></svg>
			</button>
		{/if}
		<button
			type="submit"
			aria-label="Send"
			class="opt flex size-10 shrink-0 items-center justify-center rounded-full bg-clay text-on-clay disabled:opacity-50"
			disabled={!text.trim() || sending}
			data-testid="message-send"
		>
			<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M5 12l7-7 7 7"></path></svg>
		</button>
	</form>
</div>
