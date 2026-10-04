<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { connectTenzo } from '#lib/tenzo.svelte.ts';

	let { children } = $props();

	// One connection for every screen; moving between them never reconnects.
	onMount(connectTenzo);
</script>

<svelte:head>
	<title>Tenzo</title>
</svelte:head>

{@render children()}
