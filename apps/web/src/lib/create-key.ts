/**
 * The key New thread sends with `thread.create`, so trying Start again after a dropped
 * connection can't start a second thread: the daemon answers a key it has seen with the thread
 * it made then. One key per request: the same words in the same project try again under the
 * same key; changed words or another project are a new request, under a new key.
 */
export interface CreateKey {
	readonly key: string;
	readonly prompt: string;
	readonly project: string;
}

/** The key for starting `prompt` in `project`, given the one the last attempt used (if any). */
export function keyFor(
	last: CreateKey | null,
	prompt: string,
	project: string,
	make: () => string = randomKey
): CreateKey {
	if (last && last.prompt === prompt && last.project === project) return last;
	return { key: make(), prompt, project };
}

/**
 * 128 random bits as hex. `getRandomValues` rather than `randomUUID`: the latter exists only in
 * secure contexts, and a phone may reach the daemon over plain http on the LAN.
 */
export function randomKey(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
