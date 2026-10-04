import type { Command, CommandResult, CommandType } from "@tenzo/contracts";
import type { Engine } from "./engine.ts";
import { TenzoError } from "./errors.ts";

/** How a command ended, ready for a transport to put on the wire. */
export type Outcome =
  | { ok: true; result: CommandResult<CommandType> }
  /** `fault`: the client's mistake (unknown thread, wrong answer), or ours (a bug, git failing). */
  | { ok: false; error: string; fault: "client" | "daemon" };

/**
 * Runs a command for a transport and never throws. Both transports, the CLI's
 * `POST /api/commands` and the WebSocket, come through here; they differ only in how bytes
 * arrive. A TenzoError's message is the answer; anything else is logged and reported as ours.
 */
export async function executeCommand(
  engine: Engine | undefined,
  command: Command,
  log: (message: string, error: unknown) => void = (message, error) =>
    console.error(`tenzo: ${message}`, error),
): Promise<Outcome> {
  if (!engine) return { ok: false, error: "This daemon runs no threads.", fault: "daemon" };
  try {
    return { ok: true, result: await runCommand(engine, command) };
  } catch (error) {
    if (error instanceof TenzoError) return { ok: false, error: error.message, fault: "client" };
    log(`${command.type} failed:`, error);
    return { ok: false, error: `${command.type} failed: ${String(error)}`, fault: "daemon" };
  }
}

/** Runs one client command against the engine; throws what the engine throws. */
export async function runCommand<C extends Command>(
  engine: Engine,
  command: C,
): Promise<CommandResult<C["type"]>> {
  return (await run(engine, command)) as CommandResult<C["type"]>;
}

async function run(engine: Engine, command: Command): Promise<CommandResult<CommandType>> {
  switch (command.type) {
    case "thread.create":
      return {
        thread: await engine.createThread({
          project: command.project,
          ...(command.title ? { title: command.title } : {}),
          ...(command.prompt ? { prompt: command.prompt } : {}),
          ...(command.model ? { model: command.model } : {}),
          ...(command.clientKey ? { clientKey: command.clientKey } : {}),
        }),
      };
    case "thread.send":
      return { thread: engine.send(command.threadId, command.prompt) };
    case "thread.archive":
      return {
        thread: await engine.archive(command.threadId, {
          ...(command.force !== undefined ? { force: command.force } : {}),
        }),
      };
    case "thread.list":
      return {
        threads: engine.threads({
          ...(command.project ? { project: command.project } : {}),
          ...(command.includeArchived !== undefined
            ? { includeArchived: command.includeArchived }
            : {}),
        }),
      };
    case "thread.events":
      return engine.events(command.threadId, command.after ?? 0);
    case "project.list":
      return { projects: engine.projects() };
    case "snapshot":
      return engine.snapshot();
    case "item.answer":
      return engine.answer(command.itemId, command.answer);
    case "item.snooze":
      return engine.snooze(command.itemId);
    case "item.unsnooze":
      return engine.unsnooze(command.itemId);
  }
}
