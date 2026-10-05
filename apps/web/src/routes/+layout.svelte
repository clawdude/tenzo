<script lang="ts">
	import '../app.css';
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import { track } from '#lib/nav.ts';
	import { isOpenMessage, staleTags } from '#lib/notifications.ts';
	import PairDevice from '#lib/PairDevice.svelte';
	import { closeNotifications, resendSubscription } from '#lib/push.ts';
	import { command, connectTenzo, tenzo } from '#lib/tenzo.svelte.ts';

	let { children } = $props();

	// One connection for every screen; moving between them never reconnects.
	onMount(connectTenzo);
	// Where we are in the app's history, so screens can leave the way back would.
	afterNavigate(track);

	// A notification tapped while the app is open: the service worker focuses it and says which
	// card (`/?item=…`); the Pass brings that card to the front.
	onMount(() => {
		if (!('serviceWorker' in navigator)) return;
		const onMessage = (event: MessageEvent) => {
			if (isOpenMessage(event.data)) void goto(event.data.url);
		};
		navigator.serviceWorker.addEventListener('message', onMessage);
		return () => navigator.serviceWorker.removeEventListener('message', onMessage);
	});

	// Looking at Tenzo: notifications of threads that no longer need you go (a push can't take
	// one back, so the app does).
	let visible = $state(true);
	onMount(() => {
		const update = () => (visible = document.visibilityState === 'visible');
		update();
		document.addEventListener('visibilitychange', update);
		return () => document.removeEventListener('visibilitychange', update);
	});
	$effect(() => {
		const items = tenzo.state.items;
		if (!visible || !tenzo.state.synced) return;
		void closeNotifications((tags) => staleTags(tags, items));
	});

	// Once per open, a paired device gives the daemon its push subscription again: a push service
	// may have rotated it. Nothing happens without one made with the daemon's key.
	let resent = false;
	$effect(() => {
		if (resent || tenzo.access !== 'paired' || !tenzo.online) return;
		resent = true;
		void command({ type: 'device.list' })
			.then(({ pushKey }) =>
				resendSubscription(pushKey, (subscription) =>
					command({ type: 'device.subscribe', subscription })
				)
			)
			.catch(() => {
				// offline or refused: the next open tries again
			});
	});
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
