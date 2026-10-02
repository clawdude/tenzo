import { z } from "zod";
import { EnvironmentId } from "./ids.ts";

export * from "./ids.ts";
export * from "./runtime.ts";
export * from "./queue.ts";
export * from "./commands.ts";

export const Health = z.object({
  ok: z.literal(true),
  version: z.string(),
  environmentId: EnvironmentId,
});
export type Health = z.infer<typeof Health>;

// Frames the daemon sends over the WebSocket.
export const ServerHello = z.object({
  type: z.literal("hello"),
  environmentId: EnvironmentId,
  version: z.string(),
  serverTime: z.string(),
});
export const ServerPong = z.object({
  type: z.literal("pong"),
  at: z.string(),
});
export const ServerFrame = z.discriminatedUnion("type", [ServerHello, ServerPong]);
export type ServerFrame = z.infer<typeof ServerFrame>;

// Frames a client sends to the daemon.
export const ClientPing = z.object({
  type: z.literal("ping"),
  at: z.string(),
});
export const ClientFrame = z.discriminatedUnion("type", [ClientPing]);
export type ClientFrame = z.infer<typeof ClientFrame>;
