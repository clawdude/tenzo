<script lang="ts">
	import type { ConnectionSnapshot } from '@tenzo/client-runtime';
	import { connectionLabel } from '#lib/status.ts';

	// Placeholder until #2 wires a live Connection to the daemon's WebSocket.
	const snapshot: ConnectionSnapshot = {
		state: 'closed',
		attempt: 0,
		environmentId: null,
		serverVersion: null
	};
</script>

<main class="flex min-h-dvh flex-col items-center justify-center gap-3 bg-black text-neutral-200">
	<h1 class="text-2xl font-semibold tracking-tight">Tenzo</h1>
	<p class="text-sm text-neutral-500">{connectionLabel(snapshot)}</p>
</main>
