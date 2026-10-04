/**
 * One timer per key, for things the daemon does at a time kept in its log: a snoozed item
 * coming back (keyed by item), an agent's `wake_me` (keyed by thread). The time itself lives in
 * the log, so a restarted daemon arms them again; this only holds the timers of this process.
 *
 * Node holds a timer for at most ~24.8 days, so a later time fires early. `fire` therefore
 * always checks the time it is for, and arms again if it hasn't come.
 */
export class Timers<K> {
  readonly #timers = new Map<K, NodeJS.Timeout>();

  /** Calls `fire(key)` at `at` (ms since the epoch; at once if it has passed), replacing any timer for `key`. */
  set(key: K, at: number, fire: (key: K) => void): void {
    this.clear(key);
    const delay = Math.min(Math.max(0, at - Date.now()), MAX_TIMER_MS);
    const timer = setTimeout(() => {
      this.#timers.delete(key);
      fire(key);
    }, delay);
    timer.unref?.(); // never what keeps the process alive
    this.#timers.set(key, timer);
  }

  clear(key: K): void {
    clearTimeout(this.#timers.get(key));
    this.#timers.delete(key);
  }

  clearAll(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }
}

/** The longest a Node timer waits. */
export const MAX_TIMER_MS = 2 ** 31 - 1;
