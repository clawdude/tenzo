/**
 * A short, git-safe, lowercase slug: "Fix the login bug!" → "fix-the-login-bug". Cuts at a word
 * boundary when it can. Falls back to `fallback` when nothing usable is left.
 */
export function slugify(text: string, fallback: string, maxLength = 40): string {
  const words = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // é → e
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (words === "") return fallback;
  if (words.length <= maxLength) return words;
  const cut = words.slice(0, maxLength + 1);
  const boundary = cut.lastIndexOf("-");
  return (boundary > 0 ? cut.slice(0, boundary) : words.slice(0, maxLength)).replace(/-+$/, "");
}

/** `base`, else `base-2`, `base-3`, … : the first candidate `taken` says no to. */
export async function firstFree(
  base: string,
  taken: (candidate: string) => boolean | Promise<boolean>,
): Promise<string> {
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!(await taken(candidate))) return candidate;
  }
}
