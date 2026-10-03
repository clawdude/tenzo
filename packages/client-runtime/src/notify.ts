export type Log = (message: string, detail?: unknown) => void;

export const consoleLog: Log = (message, detail) => {
  if (detail === undefined) console.error(`tenzo: ${message}`);
  else console.error(`tenzo: ${message}`, detail);
};

/**
 * Calls each listener with `value`. A listener that throws is reported and the rest still run:
 * a view's bug must not break the socket handler that delivered the news.
 */
export function notify<T>(listeners: Iterable<(value: T) => void>, value: T, log: Log): void {
  for (const listener of [...listeners]) {
    try {
      listener(value);
    } catch (error) {
      log("a listener threw", error);
    }
  }
}
