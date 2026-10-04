import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MergeDecision, ReviewDecision, ThreadPhase } from "@tenzo/contracts";

/**
 * Tenzo's thread prompts, and what Tenzo tells the agent when you answer it.
 *
 * The prompts are plain Markdown files in `apps/daemon/prompts/`, one per phase, read each time a
 * session starts (so an edit applies to the next session, no restart). The agent gets the one for
 * the thread's phase *appended* to its own system prompt (Claude Code's preset): Tenzo adds to
 * the agent's instructions, never replaces them.
 *
 * A system prompt is fixed for the life of the agent's process, so a thread whose phase changes
 * mid-session can't swap it. Instead the answer that changes it carries the next prompt: the
 * approval of a proposal carries the build prompt (it is the `propose` tool's result,
 * `proposalReply`), Merge and Open PR carry the landing prompt (`reviewPrompt`). Every session
 * the thread starts after that (a resume after a restart or a crash) appends the new phase's
 * prompt from the start.
 */
export interface ThreadPrompts {
  discuss: string;
  build: string;
  landing: string;
}

export const PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

/** The prompts as they are on disk now, comments dropped. */
export function loadThreadPrompts(dir: string = PROMPTS_DIR): ThreadPrompts {
  const read = (name: string) => cleanPrompt(readFileSync(join(dir, name), "utf8"));
  return { discuss: read("discuss.md"), build: read("build.md"), landing: read("landing.md") };
}

/** A prompt file as the agent sees it: HTML comments (notes for whoever edits it) removed. */
export function cleanPrompt(text: string): string {
  return text
    .replaceAll(/<!--[\s\S]*?-->/g, "")
    .replaceAll(/\n{3,}/g, "\n\n")
    .trim();
}

/** The prompt a session in `phase` appends to the agent's system prompt. */
export function promptFor(prompts: ThreadPrompts, phase: ThreadPhase): string {
  switch (phase) {
    case "discussing":
      return prompts.discuss;
    case "landing":
      return prompts.landing;
    case "building":
    case "review":
      return prompts.build;
  }
}

/** The first words of an approval: what the discuss prompt tells the agent to look for. */
export const APPROVED = "Approved, build it.";

/**
 * What `propose` returns to the agent once you have answered: the approval with the build prompt
 * (see above), or your note and "propose again".
 */
export function proposalReply(
  answer: { decision: "build" } | { decision: "change"; note: string },
  prompts: ThreadPrompts | undefined,
): string {
  if (answer.decision === "build") {
    return prompts?.build ? `${APPROVED}\n\n${prompts.build}` : APPROVED;
  }
  return `Not yet. ${answer.note}\n\nRevise, and propose again.`;
}

/**
 * The message your answer to finished work sends the agent, or null for Done (nothing goes).
 * Merge and Open PR carry the landing prompt, which says what each of them means.
 */
export function reviewPrompt(
  answer: { decision: ReviewDecision; note?: string | undefined },
  prompts: ThreadPrompts,
): string | null {
  switch (answer.decision) {
    case "done":
      return null;
    case "changes":
      return `Needs changes: ${answer.note ?? ""}\n\nMake the change, run the checks, commit, and \`report\` again.`;
    case "merge":
      return `Merge: land this work through a PR. Open it, see it through CI and review, and merge it with \`gh pr merge\` once it can merge.\n\n${prompts.landing}`;
    case "pr":
      return `Open PR: open the PR and see it through CI and review, but don't merge it. Tell me with \`ready_to_merge\` once it can merge.\n\n${prompts.landing}`;
  }
}

/**
 * The message your answer to a ready PR sends the agent. Merge restates how: it is the turn
 * where an agent with no PR at hand is likeliest to find another way.
 */
export function mergePrompt(answer: { decision: MergeDecision; note?: string | undefined }): string {
  return answer.decision === "merge"
    ? "Merge: merge the PR now with `gh pr merge` (never by pushing to the default branch), check that `gh pr view` says MERGED, then call `landed` with its URL. If it can't merge, ask me why with AskUserQuestion."
    : `Not yet: ${answer.note ?? ""}\n\nSee to it, and call \`ready_to_merge\` again once it can merge.`;
}

/** What Retry on a stalled landing card sends: the turn ended with nothing to come. */
export const STALLED_PROMPT =
  "You're landing, and your last turn ended without `wake_me`, `ready_to_merge`, `landed` or a question to me, so nothing reaches my phone and nothing happens next. Look at where the PR stands, keep to the landing rules, and end this turn with one of those.";

/** The turn a wake sends (`wake_me`). */
export function wakePrompt(why: string): string {
  return `You asked to be woken: ${why}`;
}
