<script lang="ts">
	import '../app.css';
	import mark from '#lib/assets/mark.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={mark} />
	<title>Tenzo</title>
</svelte:head>

{@render children()}
