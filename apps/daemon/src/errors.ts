/**
 * An error whose message is the whole story for the person at the keyboard: a bad path, a name
 * that doesn't exist, a port in use. The CLI prints its message on one line, without a stack.
 */
export class TenzoError extends Error {
  override name = "TenzoError";
}
