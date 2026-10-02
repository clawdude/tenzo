/**
 * An unbounded async queue with one reader: `push` never blocks, the reader awaits the next item,
 * `close` ends iteration once what was pushed has been read.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  #items: T[] = [];
  #waiting: ((result: IteratorResult<T, undefined>) => void) | null = null;
  #closed = false;

  get closed(): boolean {
    return this.#closed;
  }

  push(item: T): void {
    if (this.#closed) return;
    const waiting = this.#waiting;
    if (waiting) {
      this.#waiting = null;
      waiting({ value: item, done: false });
    } else {
      this.#items.push(item);
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#waiting?.({ value: undefined, done: true });
    this.#waiting = null;
  }

  [Symbol.asyncIterator](): AsyncIterator<T, undefined> {
    return {
      next: () => {
        if (this.#items.length > 0) {
          return Promise.resolve({ value: this.#items.shift() as T, done: false });
        }
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.#waiting = resolve;
        });
      },
      return: () => {
        this.close();
        this.#items = [];
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}
