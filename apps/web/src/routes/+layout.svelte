<script lang="ts">
	import '../app.css';
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { track } from '#lib/nav.ts';
	import PairDevice from '#lib/PairDevice.svelte';
	import { connectTenzo, tenzo } from '#lib/tenzo.svelte.ts';

	let { children } = $props();

	// One connection for every screen; moving between them never reconnects.
	onMount(connectTenzo);
	// Where we are in the app's history, so screens can leave the way back would.
	afterNavigate(track);
</script>

<svelte:head>
	<title>Tenzo</title>
</svelte:head>

{#if tenzo.access === 'unpaired' && page.url.pathname !== '/pair'}
	<!-- From elsewhere and not paired: how to pair, instead of a Pass that can't load. -->
	<PairDevice />
{:else}
	{@render children()}
{/if}
