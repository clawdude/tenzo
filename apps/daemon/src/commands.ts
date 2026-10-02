import type { Command, CommandResult, CommandType } from "@tenzo/contracts";
import type { Engine } from "./engine.ts";

/**
 * Runs one client command against the engine. Every transport goes through here: the CLI's
 * `POST /api/commands` now, the WebSocket (#7) next; they differ only in how bytes arrive.
 * A TenzoError is the client's mistake (unknown thread, wrong answer); anything else is ours.
 */
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
    case "snapshot":
      return engine.snapshot();
    case "item.answer":
      return engine.answer(command.itemId, command.answer);
  }
}
