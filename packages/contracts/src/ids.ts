import { z } from "zod";

/** Stable identity of one daemon (one machine). Survives restarts and address changes. */
export const EnvironmentId = z.string().regex(/^env_[a-z0-9]{20}$/);
export type EnvironmentId = z.infer<typeof EnvironmentId>;

/** A local git repo the daemon knows about. */
export const ProjectId = z.string().regex(/^prj_[a-z0-9]{20}$/);
export type ProjectId = z.infer<typeof ProjectId>;

/** One agent session on one project, in its own worktree and branch. */
export const ThreadId = z.string().regex(/^thr_[a-z0-9]{20}$/);
export type ThreadId = z.infer<typeof ThreadId>;
