import type { Command, CommandResult, CommandType, Device } from "@tenzo/contracts";
import type { Devices } from "./devices.ts";
import type { Engine } from "./engine.ts";
import { TenzoError } from "./errors.ts";

/**
 * Who sent a command (auth.ts): the Mac itself, or a paired device. Transports run commands only
 * for one of the two; an unpaired remote request never gets this far.
 */
export type Caller = { mode: "local"; device: null } | { mode: "remote"; device: Device };

/** What the device commands need besides the engine. */
export interface CommandContext {
  devices?: Devices | undefined;
  caller?: Caller | undefined;
}

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
  context: CommandContext = {},
  log: (message: string, error: unknown) => void = (message, error) =>
    console.error(`tenzo: ${message}`, error),
): Promise<Outcome> {
  try {
    if (isDeviceCommand(command)) {
      return { ok: true, result: runDeviceCommand(command, context) };
    }
    if (!engine) return { ok: false, error: "This daemon runs no threads.", fault: "daemon" };
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
  if (isDeviceCommand(command)) {
    throw new TenzoError(`${command.type} needs to know who asks: use executeCommand.`);
  }
  return (await run(engine, command as Exclude<Command, DeviceCommand>)) as CommandResult<C["type"]>;
}

type DeviceCommand = Extract<Command, { type: `device.${string}` | "daemon.settings" }>;

/** Commands the engine has nothing to do with: devices, and the remote-access settings. */
export function isDeviceCommand(command: Command): command is DeviceCommand {
  return command.type.startsWith("device.") || command.type === "daemon.settings";
}

/**
 * The `device.*` commands (pairing and the paired devices) and `daemon.settings`: not the
 * engine's business.
 */
function runDeviceCommand(
  command: DeviceCommand,
  { devices, caller }: CommandContext,
): CommandResult<CommandType> {
  if (!devices || !caller) throw new TenzoError("This daemon keeps no devices.");
  switch (command.type) {
    case "device.pair":
      // A paired device can do everything else, but new devices are let in from the Mac only.
      if (caller.mode !== "local") {
        throw new TenzoError("Pairing links are made on the Mac itself: run `tenzo pair` there.");
      }
      return devices.pair(command.name);
    case "device.list":
      return { devices: devices.list(), current: caller.device?.id ?? null };
    case "device.rename":
      return { device: devices.rename(command.deviceId, command.name) };
    case "device.revoke":
      return { device: devices.revoke(command.deviceId) };
    case "daemon.settings":
      // How the daemon is reached from elsewhere is the Mac's business, not a phone's.
      if (caller.mode !== "local") {
        throw new TenzoError("The daemon's settings are read on the Mac itself.");
      }
      return devices.settings();
  }
}

async function run(
  engine: Engine,
  command: Exclude<Command, DeviceCommand>,
): Promise<CommandResult<CommandType>> {
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
    case "thread.setModel":
      return {
        thread: engine.setModel(command.threadId, {
          model: command.model,
          ...(command.thinking !== undefined ? { thinking: command.thinking } : {}),
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
      return engine.events(command.threadId, {
        ...(command.after !== undefined ? { after: command.after } : {}),
        ...(command.before !== undefined ? { before: command.before } : {}),
        ...(command.limit !== undefined ? { limit: command.limit } : {}),
      });
    case "thread.watch":
    case "thread.unwatch":
      // A watch is a socket's: socket.ts answers these itself, so only another transport gets here.
      throw new TenzoError(`${command.type} works over the WebSocket only.`);
    case "thread.diff":
      return engine.diff(command.threadId);
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
    case "automation.list":
      return {
        automations: engine.automations(command.project),
        paused: engine.automationsPaused,
        problems: engine.automationProblems(command.project),
      };
    case "automation.run":
      return engine.runAutomation(command.project, command.name);
    case "automation.pause":
      return { paused: engine.pauseAutomations(command.paused) };
    case "automation.archiveFinished":
      return engine.archiveFinishedRuns(command.project, command.name);
  }
}
