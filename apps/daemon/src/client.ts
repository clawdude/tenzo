import {
  type Command,
  type CommandResult,
  CommandResponse,
  CommandResults,
} from "@tenzo/contracts";
import type { DaemonConfig } from "./config.ts";
import { TenzoError } from "./errors.ts";

/**
 * The CLI's way into a running daemon: one command, one answer, over `POST /api/commands`.
 * Thread commands go through here so the daemon, which runs the agents, sees everything.
 */
export async function callDaemon<C extends Command>(
  config: Pick<DaemonConfig, "host" | "port">,
  command: C,
): Promise<CommandResult<C["type"]>> {
  let response: Response;
  try {
    response = await fetch(`http://${config.host}:${config.port}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    });
  } catch {
    throw new TenzoError(
      `Tenzo isn't running on ${config.host}:${config.port}. Start it with \`tenzo serve\` (same TENZO_PORT and TENZO_HOME).`,
    );
  }
  let body: CommandResponse;
  try {
    body = CommandResponse.parse(await response.json());
  } catch {
    throw new TenzoError(
      `Something other than tenzo answered on ${config.host}:${config.port} (HTTP ${response.status}).`,
    );
  }
  if (!body.ok) throw new TenzoError(body.error);
  const type = command.type as C["type"];
  return CommandResults[type].parse(body.result) as CommandResult<C["type"]>;
}
