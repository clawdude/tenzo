<script lang="ts">
	import type { Device } from '@tenzo/client-runtime';
	import { onMount } from 'svelte';
	import { deviceLine, splitDevices } from '#lib/devices.ts';
	import { back } from '#lib/nav.ts';
	import {
		browserFacts,
		currentSubscription,
		pushLine,
		subscribeBrowser,
		subscriptionInfo,
		type Support,
		supportOf,
		unsubscribeBrowser
	} from '#lib/push.ts';
	import { connectionLabel } from '#lib/status.ts';
	import { command, tenzo } from '#lib/tenzo.svelte.ts';

	// Devices (PRODUCT.md §9), minimal: this device, and every paired one with Rename and Revoke.
	// Pairing a new one happens on the Mac (`tenzo pair`), never from here.
	let devices = $state.raw<Device[]>([]);
	let current = $state<string | null>(null);
	let loaded = $state(false);
	let note = $state<string | null>(null);
	/** The device whose name is being edited, and the draft. */
	let renaming = $state<string | null>(null);
	let draft = $state('');
	/** The device whose Revoke is asking to be confirmed. */
	let confirming = $state<string | null>(null);
	let busy = $state(false);
	let now = $state(Date.now());
	/** The daemon's push key; null: it sends no notifications. */
	let pushKey = $state<string | null>(null);
	/** What this browser can do about notifications. */
	let support = $state.raw<Support>({ kind: 'none' });
	/** This browser holds a push subscription. */
	let subscribedHere = $state(false);

	const split = $derived(splitDevices(devices, current));

	async function load() {
		try {
			const result = await command({ type: 'device.list' });
			devices = result.devices;
			current = result.current;
			pushKey = result.pushKey;
			subscribedHere = (await currentSubscription().catch(() => null)) !== null;
			loaded = true;
			now = Date.now();
		} catch (error) {
			note = error instanceof Error ? error.message : String(error);
		}
	}

	async function run(fn: () => Promise<unknown>): Promise<void> {
		busy = true;
		note = null;
		try {
			await fn();
			await load();
		} catch (error) {
			note = error instanceof Error ? error.message : String(error);
		} finally {
			busy = false;
		}
	}

	function rename(id: string) {
		const name = draft.trim();
		renaming = null;
		if (name === '') return;
		void run(() => command({ type: 'device.rename', deviceId: id, name }));
	}

	function revoke(id: string) {
		confirming = null;
		void run(() => command({ type: 'device.revoke', deviceId: id }));
	}

	// Notifications (PRODUCT.md §9). Turning them on asks the browser first, straight from the
	// tap: iOS shows the prompt only then, and only in the home-screen app.
	function enablePush() {
		const key = pushKey;
		if (!key) return;
		void run(async () => {
			const subscription = subscriptionInfo(await subscribeBrowser(key));
			await command({ type: 'device.subscribe', subscription });
		}).then(() => {
			if (note === null) note = 'Notifications are on. Test sends one now.';
		});
	}

	function disablePush() {
		void run(async () => {
			await command({ type: 'device.unsubscribe' });
			await unsubscribeBrowser();
		});
	}

	function mute(id: string, muted: boolean) {
		void run(() => command({ type: 'device.mute', deviceId: id, muted }));
	}

	function testPush(device: Device) {
		let said: string | null = null;
		void run(async () => {
			const { sent, error } = await command({ type: 'device.testPush', deviceId: device.id });
			said = sent ? `Sent to ${device.name}. It should arrive in a few seconds.` : error;
		}).then(() => {
			if (note === null) note = said;
		});
	}

	// Load once connected (a reload lands here before the socket is up).
	$effect(() => {
		if (tenzo.online && !loaded) void load();
	});

	onMount(() => {
		support = supportOf(browserFacts());
		const tick = setInterval(() => (now = Date.now()), 60_000);
		return () => clearInterval(tick);
	});
</script>

<svelte:head>
	<title>Devices · Tenzo</title>
</svelte:head>

{#snippet card(device: Device, top: boolean, bottom: boolean)}
	<article
		class={[
			'flex flex-col gap-1 bg-card px-[18px] pt-3 pb-3.5',
			top ? 'rounded-t-[20px]' : 'rounded-t-[6px]',
			bottom ? 'rounded-b-[20px]' : 'rounded-b-[6px]'
		]}
		data-testid="device"
		data-id={device.id}
		data-current={device.id === current}
	>
		{#if renaming === device.id}
			<form
				class="flex items-center gap-2"
				onsubmit={(event) => {
					event.preventDefault();
					rename(device.id);
				}}
			>
				<!-- svelte-ignore a11y_autofocus -->
				<input
					class="min-h-11 min-w-0 grow rounded-[12px] bg-fill px-3 text-[16px] text-ink"
					aria-label="Name"
					maxlength="60"
					autofocus
					bind:value={draft}
					data-testid="device-name-input"
				/>
				<button type="submit" class="opt min-h-11 rounded-full bg-fill px-4 text-[15px] font-medium">Save</button>
			</form>
		{:else}
			<span class="min-w-0 truncate font-semibold" data-testid="device-name">{device.name}</span>
		{/if}
		<p class="text-[14px] leading-[1.35] text-mute">{deviceLine(device, now)}</p>
		{#if pushKey}
			<p class="text-[14px] leading-[1.35] text-mute" data-testid="push-line">{pushLine(device)}</p>
		{/if}

		{#if confirming === device.id}
			<div class="mt-1 flex flex-col gap-2.5" data-testid="confirm-revoke">
				<p class="text-[15px] leading-[1.35]">
					{device.id === current
						? 'Revoke this device? It disconnects now, and needs tenzo pair on the Mac to come back.'
						: `Revoke ${device.name}? It disconnects now, and needs tenzo pair on the Mac to come back.`}
				</p>
				<div class="flex gap-2">
					<button
						type="button"
						class="opt min-h-11 rounded-full bg-fill px-4 text-[15px] font-medium text-fail"
						onclick={() => revoke(device.id)}
						data-testid="revoke-confirm">Revoke</button
					>
					<button
						type="button"
						class="opt min-h-11 rounded-full px-4 text-[15px] text-mute"
						onclick={() => (confirming = null)}>Cancel</button
					>
				</div>
			</div>
		{:else if renaming !== device.id}
			<div class="mt-1 flex flex-wrap items-center gap-2">
				<button
					type="button"
					class="opt min-h-11 rounded-full bg-fill px-4 text-[15px] font-medium disabled:opacity-50"
					disabled={!tenzo.online || busy}
					onclick={() => {
						draft = device.name;
						renaming = device.id;
					}}
					data-testid="rename">Rename</button
				>
				<button
					type="button"
					class="opt min-h-11 rounded-full px-3 text-[15px] text-mute disabled:opacity-50"
					disabled={!tenzo.online || busy}
					onclick={() => (confirming = device.id)}
					data-testid="revoke">Revoke</button
				>
			</div>
			{#if pushKey}
				{@render notifications(device)}
			{/if}
		{/if}
	</article>
{/snippet}

{#snippet notifications(device: Device)}
	{@const here = device.id === current}
	{@const on = device.push.subscribed && (!here || subscribedHere)}
	{#if here && !on && support.kind === 'home-screen'}
		<p class="text-[14px] leading-[1.35] text-mute" data-testid="push-home-screen">
			Notifications on iPhone need Tenzo on the Home Screen: Share → Add to Home Screen, open it
			from there and pair it, then turn them on in its Devices.
		</p>
	{:else if here && !on && support.kind === 'none'}
		<p class="text-[14px] leading-[1.35] text-mute">This browser can't show notifications.</p>
	{:else if here && !on && support.kind === 'ready' && support.permission === 'denied'}
		<p class="text-[14px] leading-[1.35] text-mute">
			Notifications are blocked for Tenzo in this browser's settings.
		</p>
	{:else if here && !on}
		<div class="flex flex-wrap items-center gap-2">
			<button
				type="button"
				class="opt min-h-11 rounded-full bg-fill px-4 text-[15px] font-medium disabled:opacity-50"
				disabled={!tenzo.online || busy}
				onclick={enablePush}
				data-testid="push-enable">Turn on notifications</button
			>
		</div>
	{:else if on}
		<div class="flex flex-wrap items-center gap-2">
			<button
				type="button"
				class="opt min-h-11 rounded-full bg-fill px-4 text-[15px] font-medium disabled:opacity-50"
				disabled={!tenzo.online || busy}
				onclick={() => mute(device.id, !device.push.muted)}
				data-testid="push-mute">{device.push.muted ? 'Unmute' : 'Mute'}</button
			>
			<button
				type="button"
				class="opt min-h-11 rounded-full px-3 text-[15px] text-mute disabled:opacity-50"
				disabled={!tenzo.online || busy}
				onclick={() => testPush(device)}
				data-testid="push-test">Test</button
			>
			{#if here}
				<button
					type="button"
					class="opt min-h-11 rounded-full px-3 text-[15px] text-mute disabled:opacity-50"
					disabled={!tenzo.online || busy}
					onclick={disablePush}
					data-testid="push-disable">Turn off</button
				>
			{/if}
		</div>
	{/if}
{/snippet}

<main class="fixed inset-0 overflow-hidden bg-black text-ink" data-testid="devices-list">
	<div
		class="scroll mx-auto flex h-full w-full max-w-[440px] flex-col overflow-y-auto pt-[calc(env(safe-area-inset-top)+14px)] pb-[calc(env(safe-area-inset-bottom)+40px)] sm:pt-6"
	>
		<header class="mb-[22px] flex items-end justify-between gap-4 px-6">
			<div class="flex min-w-0 flex-col gap-0.5">
				<h1 class="text-[34px] leading-[1.1] font-bold tracking-[-0.02em]">Devices</h1>
				<p class="truncate text-[15px] text-mute" aria-live="polite">
					{#if !tenzo.online}
						{connectionLabel(tenzo.state.connection)}
					{:else if loaded}
						{devices.length === 1 ? '1 paired' : `${devices.length} paired`}
					{/if}
				</p>
			</div>
			<button
				type="button"
				aria-label="Close"
				class="opt flex size-11 shrink-0 items-center justify-center rounded-full bg-card text-ink"
				onclick={back}
				data-testid="close"
			>
				<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"></path></svg>
			</button>
		</header>

		<div class="flex flex-col gap-[26px] px-5">
			<section class="flex flex-col">
				<h2 class="px-1 pb-1.5 text-[13px] font-semibold tracking-[0.06em] text-mute uppercase">
					This device
				</h2>
				{#if tenzo.access === 'local'}
					<p class="rounded-[20px] bg-card px-[18px] py-3.5 text-[15px] leading-[1.35] text-mute" data-testid="this-mac">
						The Mac Tenzo runs on. It needs no pairing, and gets no notifications: they go to
						paired devices.
					</p>
				{:else if split.mine}
					{@render card(split.mine, true, true)}
				{:else if loaded}
					<p class="rounded-[20px] bg-card px-[18px] py-3.5 text-[15px] text-mute">Not paired.</p>
				{/if}
			</section>

			{#if loaded}
				<section class="flex flex-col gap-0.5">
					<h2 class="px-1 pb-1.5 text-[13px] font-semibold tracking-[0.06em] text-mute uppercase">
						{split.mine ? 'Other devices' : 'Paired devices'}
					</h2>
					{#if split.others.length === 0}
						<p class="px-1 text-[15px] leading-[1.35] text-mute" data-testid="no-devices">
							None. To use Tenzo from another device, run
							<code class="font-mono text-[14px] text-ink">tenzo pair</code> on the Mac.
						</p>
					{/if}
					{#each split.others as device, i (device.id)}
						{@render card(device, i === 0, i === split.others.length - 1)}
					{/each}
				</section>
			{/if}

			{#if note}
				<p class="px-1 text-[14px] leading-[1.35] text-mute" role="status">{note}</p>
			{/if}
		</div>
	</div>
</main>
