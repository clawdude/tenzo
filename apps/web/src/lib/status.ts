import type { ConnectionSnapshot } from '@tenzo/client-runtime';

/** What the shell says about the daemon connection, in one short line. */
export function connectionLabel(snapshot: ConnectionSnapshot): string {
	switch (snapshot.state) {
		case 'closed':
			return 'Not connected';
		case 'connecting':
			return 'Connecting…';
		case 'connected':
			return snapshot.serverVersion ? `Connected · daemon ${snapshot.serverVersion}` : 'Connected';
		case 'reconnecting':
			return snapshot.attempt > 1 ? `Reconnecting (attempt ${snapshot.attempt})…` : 'Reconnecting…';
	}
}
