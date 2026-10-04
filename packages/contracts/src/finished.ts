import { z } from "zod";

/**
 * Finished work (PRODUCT.md §6): what an agent hands back with Tenzo's `report`, `attach` and
 * `expose` tools, and where the daemon serves it. Shared by the daemon and the web app, so both
 * spell the paths the same way.
 */

/** One check the agent ran, as it reports it: green, red or grey on the card. */
export const CheckStatus = z.enum(["pass", "fail", "skipped"]);
export type CheckStatus = z.infer<typeof CheckStatus>;

export const Check = z.object({
  /** A word or two: "Tests", "Typecheck", "Lint". */
  name: z.string().min(1).max(60),
  status: CheckStatus,
  /** "42 passed", or the first failing line. */
  detail: z.string().max(500).optional(),
});
export type Check = z.infer<typeof Check>;

export const AttachmentId = z.string().regex(/^att_[a-z0-9]{20}$/);
export type AttachmentId = z.infer<typeof AttachmentId>;

/** What `attach` takes: images only, recognised by their bytes, never by their name. */
export const ImageType = z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]);
export type ImageType = z.infer<typeof ImageType>;

/** The file name each image type is stored and served under. */
export const IMAGE_EXTENSIONS: Record<ImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

/** A screenshot the agent attached: a copy the daemon keeps, not the file in the worktree. */
export const Attachment = z.object({
  id: AttachmentId,
  /** The stored file's name: `<id>.<ext>`. */
  file: z.string().regex(/^att_[a-z0-9]{20}\.(png|jpg|gif|webp)$/),
  /** The name it had in the worktree, for showing. */
  name: z.string(),
  caption: z.string().optional(),
  mediaType: ImageType,
  bytes: z.number().int().nonnegative(),
});
export type Attachment = z.infer<typeof Attachment>;

/** A dev server the agent exposed: its port, and the page to open under the thread's base. */
export const Preview = z.object({
  port: z.number().int().min(1).max(65_535),
  /** Relative to the thread's live base, without a leading slash; "" is the base itself. */
  path: z.string(),
});
export type Preview = z.infer<typeof Preview>;

/** The finished card's content. */
export const Finished = z.object({
  /** The agent's few words; none: the card shows the thread's title. */
  headline: z.string().optional(),
  /** The handoff note: what changed. Markdown. */
  summary: z.string(),
  /** How to try it. Markdown; may be empty. */
  howToTest: z.string(),
  checks: z.array(Check),
  /** Screenshots attached since the thread's previous report, in order. */
  attachments: z.array(Attachment),
  /** The dev server exposed when it reported, if any. */
  live: Preview.nullable(),
});
export type Finished = z.infer<typeof Finished>;

/**
 * Where threads' live apps are served: a listener of their own, on another port, so a page an
 * agent serves runs on an origin that can't call Tenzo's API. `origins` are its public origins
 * (`TENZO_LIVE_ORIGIN`, e.g. a second Tailscale Serve route); `port` is its loopback port.
 */
export const LiveInfo = z.object({
  port: z.number().int().min(1).max(65_535),
  origins: z.array(z.string()),
});
export type LiveInfo = z.infer<typeof LiveInfo>;

/**
 * The live origin for a page reached at `location`: the configured origin with the same host
 * name, else the live port on that host name, same scheme. Null when the daemon has none.
 */
export function liveOriginFor(
  location: { protocol: string; hostname: string },
  live: LiveInfo | null,
): string | null {
  if (!live) return null;
  const host = location.hostname.toLowerCase();
  const named = live.origins.find(
    (origin) => /^[a-z][a-z0-9+.-]*:\/\/(\[[^\]]*\]|[^:/?#]+)/i.exec(origin)?.[1]?.toLowerCase() === host,
  );
  return named ?? `${location.protocol}//${location.hostname}:${live.port}`;
}

/**
 * Where a thread's exposed dev server is reachable on the live listener. Requests under it
 * are forwarded to the server with the path unchanged, so the server serves under this base.
 */
export function liveBase(threadId: string): string {
  return `/live/${threadId}/`;
}

/** The "Open live" link on the live origin: the thread's live base and the page the agent named. */
export function liveUrl(
  liveOrigin: string,
  threadId: string,
  preview: Pick<Preview, "path">,
): string {
  return `${liveOrigin}${liveBase(threadId)}${preview.path}`;
}

/** Where the daemon serves an attachment's copy. */
export function attachmentUrl(threadId: string, attachment: Pick<Attachment, "file">): string {
  return `/api/attachments/${threadId}/${attachment.file}`;
}
