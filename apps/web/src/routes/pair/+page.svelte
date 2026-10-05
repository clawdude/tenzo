<script lang="ts">
	import { replaceState } from '$app/navigation';
	import { onMount } from 'svelte';
	import PairDevice from '#lib/PairDevice.svelte';

	// A pairing link: `/pair#<code>`. The code is in the fragment, so no request ever carried it;
	// read it once, then take it out of the address bar and the history.
	const code = location.hash.slice(1) || null;

	onMount(() => {
		if (location.hash) replaceState('/pair', {});
	});
</script>

<svelte:head>
	<title>Pair · Tenzo</title>
</svelte:head>

<PairDevice {code} />
