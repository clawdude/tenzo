import type { ProjectView } from '@tenzo/client-runtime';

/**
 * Which project New thread starts in: the one picked last on this device, while it still exists,
 * else the first. Remembered in this browser only; nothing is lost without it.
 */

export const LAST_PROJECT_KEY = 'tenzo.lastProject';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

export function chooseProject(
	projects: readonly ProjectView[],
	remembered: string | null
): ProjectView | null {
	return projects.find((p) => p.id === remembered) ?? projects[0] ?? null;
}

/** The project id picked last, or null (none yet, or storage is off: private mode, a preview). */
export function rememberedProject(store: Store | null = browserStore()): string | null {
	try {
		return store?.getItem(LAST_PROJECT_KEY) ?? null;
	} catch {
		return null;
	}
}

export function rememberProject(id: string, store: Store | null = browserStore()): void {
	try {
		store?.setItem(LAST_PROJECT_KEY, id);
	} catch {
		// Not remembered: next time starts from the first project.
	}
}

function browserStore(): Store | null {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}
