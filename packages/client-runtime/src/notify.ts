export type Log = (message: string, detail?: unknown) => void;

export const consoleLog: Log = (message, detail) => {
  if (detail === undefined) console.error(`tenzo: ${message}`);
  else console.error(`tenzo: ${message}`, detail);
};

/**
 * Calls each listener with `value`. A listener that throws is reported and the rest still run:
 * a view's bug must not break the socket handler that delivered the news.
 *
 * `current` says whether `value` is still the latest. A listener may cause a newer value (it
 * calls `close()` on hearing "reconnecting", say); that one has already reached every listener,
 * so this round stops instead of handing the rest the stale value after it.
 */
export function notify<T>(
  listeners: Iterable<(value: T) => void>,
  value: T,
  log: Log,
  current: () => boolean = () => true,
): void {
  for (const listener of [...listeners]) {
    if (!current()) return;
    try {
      listener(value);
    } catch (error) {
      log("a listener threw", error);
    }
  }
}
