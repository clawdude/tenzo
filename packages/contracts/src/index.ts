import { z } from "zod";
import { EnvironmentId } from "./ids.ts";

export * from "./ids.ts";
export * from "./runtime.ts";
export * from "./queue.ts";
export * from "./commands.ts";
export * from "./frames.ts";

export const Health = z.object({
  ok: z.literal(true),
  version: z.string(),
  environmentId: EnvironmentId,
});
export type Health = z.infer<typeof Health>;
