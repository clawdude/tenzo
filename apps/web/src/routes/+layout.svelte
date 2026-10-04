<script lang="ts">
	import '../app.css';

	let { children } = $props();
</script>

<svelte:head>
	<title>Tenzo</title>
</svelte:head>

{@render children()}
