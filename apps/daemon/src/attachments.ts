import { constants } from "node:fs";
import { mkdir, open, realpath, rm, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type Attachment,
  AttachmentId,
  IMAGE_EXTENSIONS,
  type ImageType,
  ThreadId,
} from "@tenzo/contracts";
import { TenzoError } from "./errors.ts";
import { randomId } from "./ids.ts";

/**
 * Screenshots an agent attaches to its report (Tenzo's `attach`). Only images inside the
 * thread's own worktree, after symlinks are resolved, recognised by their bytes. The daemon
 * keeps a copy under `<home>/attachments/<thread>/`, so what the card shows is what was attached
 * even if the worktree changes later, and it serves only those copies (app.ts).
 */

/** The largest file `attach` takes. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** How many screenshots one report carries at most. */
export const MAX_ATTACHMENTS = 8;
const CAPTION_LIMIT = 200;

/** Where a thread's attached copies live. */
export function attachmentsDir(home: string, threadId: string): string {
  return join(home, "attachments", threadId);
}

/**
 * Copies the image at `path` (relative to the worktree, or absolute) into `dir`, if it is a
 * regular file inside `worktree` once every symlink is resolved, an image, and small enough.
 * Throws a TenzoError that tells the agent what to do otherwise.
 */
export async function takeAttachment(input: {
  worktree: string;
  path: string;
  caption?: string | undefined;
  dir: string;
}): Promise<Attachment> {
  const asked = input.path.trim();
  if (asked === "") throw new TenzoError("Give the path of an image file in this worktree.");
  const root = await realpath(input.worktree);
  let real: string;
  try {
    real = await realpath(resolve(input.worktree, asked));
  } catch {
    throw new TenzoError(`There is no file at ${asked}.`);
  }
  if (!inside(root, real)) {
    throw new TenzoError(
      `${asked} is outside this thread's worktree (${root}). Only files in the worktree can be attached: save the screenshot there.`,
    );
  }
  // No symlink can be swapped in between the check above and the read: O_NOFOLLOW on the
  // resolved path, and the size and type come from the open file itself.
  let bytes: Buffer;
  const handle = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new TenzoError(`Can't read ${asked}.`);
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new TenzoError(`${asked} is not a file.`);
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      throw new TenzoError(
        `${asked} is ${megabytes(stat.size)}; the limit is ${megabytes(MAX_ATTACHMENT_BYTES)}. Take a smaller screenshot.`,
      );
    }
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const mediaType = sniffImage(bytes);
  if (!mediaType) {
    throw new TenzoError(`${asked} is not a PNG, JPEG, GIF or WebP image. Attach a screenshot.`);
  }
  const id = randomId("att");
  const file = `${id}.${IMAGE_EXTENSIONS[mediaType]}`;
  await mkdir(input.dir, { recursive: true });
  await writeFile(join(input.dir, file), bytes, { flag: "wx" });
  const caption = input.caption?.replaceAll(/\s+/g, " ").trim().slice(0, CAPTION_LIMIT);
  return {
    id,
    file,
    name: basename(real),
    ...(caption ? { caption } : {}),
    mediaType,
    bytes: bytes.length,
  };
}

/** The image type the bytes start with, or null. SVG is not an image here: it can run script. */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "image/gif"; // GIF8
  // RIFF....WEBP
  if (starts(0x52, 0x49, 0x46, 0x46) && [0x57, 0x45, 0x42, 0x50].every((b, i) => bytes[8 + i] === b)) {
    return "image/webp";
  }
  return null;
}

const MEDIA_TYPES: Record<string, ImageType> = Object.fromEntries(
  Object.entries(IMAGE_EXTENSIONS).map(([type, ext]) => [ext, type as ImageType]),
);

/**
 * The stored copy a request names, if the names are well formed: `<thread>/<att id>.<ext>`.
 * Nothing in a request can reach outside `<home>/attachments`.
 */
export function storedAttachment(
  home: string,
  threadId: string,
  file: string,
): { path: string; mediaType: ImageType } | null {
  const match = /^(att_[a-z0-9]{20})\.([a-z]+)$/.exec(file);
  const mediaType = match?.[2] ? MEDIA_TYPES[match[2]] : undefined;
  if (!match || !mediaType || !AttachmentId.safeParse(match[1]).success) return null;
  if (!ThreadId.safeParse(threadId).success) return null;
  return { path: join(attachmentsDir(home, threadId), file), mediaType };
}

/** Removes a thread's copies (it was archived: its card is gone). */
export async function removeAttachments(home: string, threadId: string): Promise<void> {
  await rm(attachmentsDir(home, threadId), { recursive: true, force: true });
}

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
