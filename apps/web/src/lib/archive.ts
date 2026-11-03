/**
 * Archiving a thread by hand (the mock-up's replies/4): it always asks first, in a sheet. Its
 * agent stops, its worktree goes, its branch stays. Only when the worktree holds uncommitted
 * changes (the daemon counts them: `thread.uncommitted`) does the sheet warn, and then it
 * archives with `force`, which discards them.
 */

export interface ArchiveSheetView {
	/** What would be lost, in clay-red; null with a clean worktree, or while counting. */
	warning: string | null;
	/** The filled button. */
	confirm: 'Archive' | 'Archive anyway';
	/** Archive with `force`: you were told what goes with it. */
	force: boolean;
}

/**
 * The sheet for a worktree with `files` uncommitted (null: not counted yet), or for a thread
 * whose repo is `gone` (moved or deleted: the daemon said so when it refused).
 */
export function archiveSheet(files: number | null, gone = false): ArchiveSheetView {
	if (gone) {
		return {
			warning: 'Its repo is gone (moved or deleted). Archiving forgets the thread and deletes its worktree.',
			confirm: 'Archive anyway',
			force: true
		};
	}
	if (!files) return { warning: null, confirm: 'Archive', force: false };
	const what =
		files === 1
			? "1 file has changes that aren't committed. It'll be lost."
			: `${files} files have changes that aren't committed. They'll be lost.`;
	return { warning: what, confirm: 'Archive anyway', force: true };
}

/**
 * Why the daemon refused an archive that `force` would do: uncommitted work that came after the
 * count (the agent wrote a file meanwhile: count again and warn), or a repo that is gone (warn,
 * and offer Archive anyway). Null: some other refusal, shown in its own words.
 */
export function refusalOf(message: string): 'changes' | 'gone' | null {
	if (/uncommitted changes/i.test(message)) return 'changes';
	if (/is gone \(moved or deleted\)/i.test(message)) return 'gone';
	return null;
}
