<script lang="ts">
	import '../app.css';
	import { afterNavigate } from '$app/navigation';
	import { onMount } from 'svelte';
	import { track } from '#lib/nav.ts';
	import { connectTenzo } from '#lib/tenzo.svelte.ts';

	let { children } = $props();

	// One connection for every screen; moving between them never reconnects.
	onMount(connectTenzo);
	// Where we are in the app's history, so screens can leave the way back would.
	afterNavigate(track);
</script>

<svelte:head>
	<title>Tenzo</title>
</svelte:head>

{@render children()}
