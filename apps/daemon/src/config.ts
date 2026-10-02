export const DEFAULT_PORT = 4780;

export interface DaemonConfig {
  /** Loopback only; remote access goes through Tailscale Serve (PRODUCT.md, M4). */
  host: "127.0.0.1";
  port: number;
}

/** Reads daemon settings from the environment, failing loudly on nonsense. */
export function readConfig(env: Record<string, string | undefined>): DaemonConfig {
  const raw = env.TENZO_PORT;
  if (raw === undefined || raw === "") return { host: "127.0.0.1", port: DEFAULT_PORT };
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`TENZO_PORT must be an integer between 1 and 65535, got "${raw}"`);
  }
  return { host: "127.0.0.1", port };
}
