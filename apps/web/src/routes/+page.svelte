<script lang="ts">
	import { Connection, type ConnectionSnapshot } from '@tenzo/client-runtime';
	import { onMount } from 'svelte';
	import mark from '#lib/assets/mark.svg';
	import { connectionLabel, connectionTone, daemonSocketUrl } from '#lib/status.ts';

	let snapshot = $state<ConnectionSnapshot>({
		state: 'closed',
		attempt: 0,
		environmentId: null,
		serverVersion: null
	});
	const tone = $derived(connectionTone(snapshot));

	onMount(() => {
		const connection = new Connection({ url: daemonSocketUrl(location) });
		const unsubscribe = connection.subscribe((next) => (snapshot = next));
		connection.connect();
		return () => {
			unsubscribe();
			connection.close();
		};
	});
</script>

<main class="flex min-h-dvh flex-col items-center justify-center gap-6 text-neutral-200">
	<img src={mark} alt="Tenzo" class="size-16" />
	<p
		class="flex items-center gap-2 text-sm text-neutral-500"
		data-testid="connection"
		data-state={snapshot.state}
		aria-live="polite"
	>
		<span
			class={[
				'size-1.5 rounded-full',
				tone === 'live' && 'bg-emerald-500',
				tone === 'waiting' && 'animate-pulse bg-neutral-500',
				tone === 'off' && 'bg-neutral-700'
			]}
		></span>
		{connectionLabel(snapshot)}
	</p>
</main>
