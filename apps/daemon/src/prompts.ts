import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ThreadPhase } from "@tenzo/contracts";

/**
 * Tenzo's thread prompts, and what its `propose` tool answers the agent.
 *
 * The prompts are plain Markdown files in `apps/daemon/prompts/`, one per phase, read each time a
 * session starts (so an edit applies to the next session, no restart). The agent gets the one for
 * the thread's phase *appended* to its own system prompt (Claude Code's preset): Tenzo adds to
 * the agent's instructions, never replaces them.
 *
 * A system prompt is fixed for the life of the agent's process, so a thread that is approved
 * mid-session can't swap it. Instead the approval itself carries the build prompt (it is the
 * `propose` tool's result, `proposalReply`), the discuss prompt already says that an approval
 * means "build, and carry out follow-ups directly", and every session the thread starts after
 * that (a resume after a restart or a crash) appends the build prompt from the start.
 */
export interface ThreadPrompts {
  discuss: string;
  build: string;
}

export const PROMPTS_DIR = fileURLToPath(new URL("../prompts/", import.meta.url));

/** The prompts as they are on disk now, comments dropped. */
export function loadThreadPrompts(dir: string = PROMPTS_DIR): ThreadPrompts {
  const read = (name: string) => cleanPrompt(readFileSync(join(dir, name), "utf8"));
  return { discuss: read("discuss.md"), build: read("build.md") };
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
  return phase === "discussing" ? prompts.discuss : prompts.build;
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
