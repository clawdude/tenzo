import {
	type Command,
	type CommandResult,
	CommandError,
	EMPTY,
	emptyFeed,
	type Feed,
	TenzoClient,
	type TenzoState
} from '@tenzo/client-runtime';
import { daemonSocketUrl } from './status.ts';

/**
 * The app's one connection to the daemon, shared by every screen: the Pass, New thread and the
 * Threads list read the same live state, and moving between them never reconnects.
 */
class Tenzo {
	/** The connection and the daemon's projects, threads and open items, live. */
	state = $state.raw<TenzoState>({
		...EMPTY,
		connection: {
			state: 'closed',
			attempt: 0,
			environmentId: null,
			serverVersion: null,
			probing: false
		},
		synced: false
	});
	/** The daemon's data has arrived at least once; until then an empty list means nothing. */
	seen = $state(false);
	/** Connected right now: commands can go. */
	online = $derived(this.state.connection.state === 'connected');
}

export const tenzo = new Tenzo();

let client: TenzoClient | null = null;

/** Screens following a thread's events, attached to whichever client is open. */
interface Watcher {
	threadId: string;
	listener: (feed: Feed) => void;
	detach: (() => void) | null;
}
const watchers = new Set<Watcher>();

/** Opens the connection (the app's layout does, once). Returns the close function. */
export function connectTenzo(): () => void {
	const opened = new TenzoClient({ url: daemonSocketUrl(location) });
	client = opened;
	const unsubscribe = opened.subscribe((next) => {
		if (next.synced) tenzo.seen = true;
		tenzo.state = next;
	});
	// Screens may start watching before the layout connects (children mount first).
	for (const w of watchers) w.detach = opened.watch(w.threadId, w.listener);
	opened.connect();
	return () => {
		for (const w of watchers) {
			w.detach?.();
			w.detach = null;
		}
		unsubscribe();
		opened.close();
		if (client === opened) client = null;
	};
}

/**
 * Follows a thread's events (`TenzoClient.watch`): `listener` gets its feed now and on every
 * change, live. Returns the unwatch, for an `$effect` to return.
 */
export function watchThread(threadId: string, listener: (feed: Feed) => void): () => void {
	const watcher: Watcher = { threadId, listener, detach: null };
	watchers.add(watcher);
	listener(client?.feed(threadId) ?? emptyFeed(threadId));
	if (client) watcher.detach = client.watch(threadId, listener);
	return () => {
		watchers.delete(watcher);
		watcher.detach?.();
	};
}

/** Pages earlier events into a watched thread's feed. */
export function loadOlder(threadId: string): Promise<void> {
	return client ? client.loadOlder(threadId) : Promise.resolve();
}

/** Runs a command on the daemon (see `TenzoClient.command`). */
export function command<C extends Command>(command: C): Promise<CommandResult<C['type']>> {
	if (!client) {
		return Promise.reject(
			new CommandError('offline', "Not connected to Tenzo. Try again once it's back.")
		);
	}
	return client.command(command);
}
