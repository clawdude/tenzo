<script lang="ts">
	import { goto } from '$app/navigation';
	import { fetchSession, pairBrowser, pairingCode } from '@tenzo/client-runtime';
	import { onMount } from 'svelte';
	import { resumeTenzo, tenzo } from '#lib/tenzo.svelte.ts';

	// Pairing (PRODUCT.md §9): what a browser from elsewhere sees until it is paired. `tenzo pair`
	// on the Mac prints a one-time link and QR code; opening it here lands on /pair with the code in
	// the fragment (never sent with a request), which is traded once for this device's own token.
	// The link can also be pasted. Then on to the Pass.

	interface Props {
		/** Pair at once with the code from the link that opened the page. */
		code?: string | null;
	}
	let { code = null }: Props = $props();

	let pasted = $state('');
	let pairing = $state(false);
	let problem = $state<string | null>(null);

	async function pair(raw: string) {
		const found = pairingCode(raw);
		if (!found) {
			problem = 'That isn’t a pairing link. Paste the whole link `tenzo pair` printed.';
			return;
		}
		pairing = true;
		problem = null;
		const result = await pairBrowser(found);
		if (!result.ok) {
			pairing = false;
			problem = result.error;
			return;
		}
		// The token is a cookie this page can't see: ask the daemon whether it stuck.
		const session = await fetchSession();
		if (session?.mode === 'remote' && !session.device) {
			pairing = false;
			problem =
				'Paired, but this browser didn’t keep Tenzo’s cookie. Remote access needs HTTPS: open Tenzo through its Tailscale Serve address (https://…).';
			return;
		}
		resumeTenzo();
		await goto('/', { replaceState: true });
	}

	onMount(() => {
		if (code) void pair(code);
	});
</script>

<main class="fixed inset-0 overflow-hidden bg-black text-ink" data-testid="pair-device">
	<div
		class="scroll mx-auto flex h-full w-full max-w-[440px] flex-col overflow-y-auto px-6 pt-[calc(env(safe-area-inset-top)+14px)] pb-[calc(env(safe-area-inset-bottom)+40px)] sm:pt-6"
	>
		<h1 class="mb-1.5 text-[34px] leading-[1.1] font-bold tracking-[-0.02em]">Pair this device</h1>
		{#if tenzo.access === 'local'}
			<p class="text-[17px] text-mute">
				This is the Mac Tenzo runs on: it needs no pairing.
				<a href="/" class="text-ink underline underline-offset-2">Go to the Pass</a>
			</p>
		{:else if pairing}
			<p class="text-[17px] text-mute" role="status" data-testid="pairing">Pairing…</p>
		{:else}
			<p class="text-[17px] leading-[1.4] text-mute">
				Tenzo only lets in devices you pair. On the Mac, run
				<code class="font-mono text-[15px] text-ink">tenzo pair</code> and scan its code with this
				device’s camera.
			</p>

			<form
				class="mt-7 flex flex-col gap-3 rounded-[20px] bg-card px-[18px] py-4"
				onsubmit={(event) => {
					event.preventDefault();
					void pair(pasted);
				}}
			>
				<label for="pairing-link" class="text-[15px] text-mute">Or paste its link</label>
				<input
					id="pairing-link"
					class="min-h-11 rounded-[12px] bg-fill px-3 text-[16px] text-ink placeholder:text-faint"
					placeholder="https://…/pair#…"
					autocomplete="off"
					autocapitalize="off"
					spellcheck="false"
					bind:value={pasted}
					data-testid="pairing-link"
				/>
				<button
					type="submit"
					class="opt min-h-11 self-start rounded-full bg-ink px-5 text-[15px] font-semibold text-black disabled:opacity-50"
					disabled={pasted.trim() === ''}
					data-testid="pair">Pair</button
				>
			</form>
		{/if}
		{#if problem}
			<p class="mt-4 text-[15px] leading-[1.35] text-fail" role="alert" data-testid="pair-problem">
				{problem}
			</p>
		{/if}
	</div>
</main>
