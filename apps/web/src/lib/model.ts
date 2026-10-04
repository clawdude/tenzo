import type { Command, StoredEvent, ThinkingLevel, ThreadView } from '@tenzo/client-runtime';

/**
 * The thread's "⋯": its own model and thinking level, over its project's `.tenzo/config.json`
 * (PRODUCT.md §8). Unset, the project's config decides, then the daemon's default, then Claude's.
 */

/** Models to offer as one tap; any other name can be typed. */
export const MODEL_PICKS = ['opus', 'sonnet', 'haiku'] as const;

export const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'low', 'medium', 'high'];

/** What the "⋯" says the thread runs on by its own choice, or that its project decides. */
export function overrideLabel(thread: Pick<ThreadView, 'model' | 'thinking'>): string {
	const parts = [thread.model, thread.thinking ? `thinking ${thread.thinking}` : null].filter(Boolean);
	return parts.length > 0 ? parts.join(' · ') : 'Project default';
}

/** The model the thread's session said it runs, last (`session.configured`); null before one. */
export function runningModel(events: readonly StoredEvent[]): string | null {
	for (let i = events.length - 1; i >= 0; i--) {
		const event = events[i]?.event;
		if (event?.type === 'session.configured') return event.payload.model;
	}
	return null;
}

/** The command that sets the thread's own model; blank and no thinking: the project decides. */
export function setModelCommand(
	threadId: string,
	model: string,
	thinking: ThinkingLevel | null
): Extract<Command, { type: 'thread.setModel' }> {
	const name = model.trim();
	return { type: 'thread.setModel', threadId, model: name === '' ? null : name, thinking };
}
