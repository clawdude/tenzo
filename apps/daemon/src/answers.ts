import type {
  Fingerprint,
  ItemAnswer,
  QueueItem,
  RuntimeEvent,
  RuntimeEventOf,
  UserInputAnswers,
  UserInputQuestion,
} from "@tenzo/contracts";
import { TenzoError } from "./errors.ts";
import { APPROVED } from "./prompts.ts";

/**
 * Answers to items: checking them, and delivering one to an agent that is no longer waiting.
 *
 * When the agent process that asked has ended (it crashed, or the daemon restarted), there is no
 * pending request to answer. Tenzo then resumes the agent's session and sends the answer as a
 * message saying what was asked and what you chose (`deliveryPrompt`). The agent usually just
 * carries on; if it asks exactly the same thing again in that turn (it re-runs the tool, which
 * asks for permission again), the daemon answers it with your answer instead of asking you twice
 * (`StandingReply`). "Exactly" means the same fingerprint of the full request; anything else is
 * asked again.
 */

/** An answer waiting for the agent to ask again, matched by `fingerprint`. */
export type StandingReply =
  | { kind: "question"; fingerprint: Fingerprint; answers: UserInputAnswers }
  | { kind: "permission"; fingerprint: Fingerprint; decision: "allow" | "deny"; message?: string }
  | { kind: "proposal"; fingerprint: Fingerprint; decision: "build" | "change"; note?: string };

const KINDS: Record<QueueItem["kind"], { name: string; answer: string }> = {
  question: { name: "a question", answer: "an answer to each question" },
  permission: { name: "a permission request", answer: "allow or deny" },
  proposal: { name: "a proposal", answer: "build, or what to change" },
  finished: { name: "finished work", answer: "merge, pr, done, or what needs changing" },
  ready: { name: "a PR ready to merge", answer: "merge, or what to do first" },
  error: { name: "an error", answer: "retry, archive, or what to tell the agent" },
};

/** The answer, tidied, if it fits the item; else a TenzoError saying what is wrong. */
export function checkAnswer(item: QueueItem, answer: ItemAnswer): ItemAnswer {
  if (answer.kind !== item.kind) {
    const { name, answer: how } = KINDS[item.kind];
    throw new TenzoError(`${item.id} is ${name}; answer it with ${how}.`);
  }
  if (answer.kind === "finished") {
    if (answer.decision !== "changes") return { kind: "finished", decision: answer.decision };
    const note = answer.note?.trim();
    if (!note) throw new TenzoError("Say what needs changing.");
    return { kind: "finished", decision: "changes", note };
  }
  if (answer.kind === "ready") {
    if (answer.decision === "merge") return { kind: "ready", decision: "merge" };
    const note = answer.note?.trim();
    if (!note) throw new TenzoError("Say what to do before merging.");
    return { kind: "ready", decision: "changes", note };
  }
  if (answer.kind === "error") {
    if (answer.action !== "tell") return { kind: "error", action: answer.action };
    const text = answer.text?.trim();
    if (!text) throw new TenzoError("Say what to tell it.");
    return { kind: "error", action: "tell", text };
  }
  if (answer.kind === "proposal") {
    if (answer.decision === "build") return { kind: "proposal", decision: "build" };
    const note = answer.note?.trim();
    if (!note) throw new TenzoError("Say what to change.");
    return { kind: "proposal", decision: "change", note };
  }
  if (answer.kind === "permission") {
    const message = answer.message?.trim();
    return { kind: "permission", decision: answer.decision, ...(message ? { message } : {}) };
  }
  const answers: UserInputAnswers = {};
  for (const q of item.questions) {
    const value = answer.answers[q.id]?.trim();
    if (!value) throw new TenzoError(`"${q.question || q.id}" needs an answer.`);
    answers[q.id] = value;
  }
  return { kind: "question", answers };
}

/**
 * The answer to give if the agent asks exactly this again, or null when the item carries no
 * fingerprint: then nothing is ever answered for you. Matching is on the adapter's fingerprint
 * of the full request (agent/fingerprint.ts), never on the cut-down copy items show, which two
 * different requests can share.
 */
export function standingReply(item: QueueItem, answer: ItemAnswer): StandingReply | null {
  const fingerprint = item.fingerprint;
  if (!fingerprint) return null;
  switch (answer.kind) {
    case "error":
      return null; // no agent asked it, so it can't ask again
    case "question":
      return { kind: "question", fingerprint, answers: answer.answers };
    case "permission":
      return {
        kind: "permission",
        fingerprint,
        decision: answer.decision,
        ...(answer.message ? { message: answer.message } : {}),
      };
    case "proposal":
      return {
        kind: "proposal",
        fingerprint,
        decision: answer.decision,
        ...(answer.note ? { note: answer.note } : {}),
      };
    case "finished":
    case "ready":
      return null; // nothing waits on a report or a ready PR, so nothing is asked again
  }
}

/** An event that opens an item: what a standing reply can answer. */
export type AskEvent =
  | RuntimeEventOf<"user-input.requested">
  | RuntimeEventOf<"request.opened">
  | RuntimeEventOf<"proposal.requested">;

export function isAsk(event: RuntimeEvent): event is AskEvent {
  return (
    event.type === "user-input.requested" ||
    event.type === "request.opened" ||
    event.type === "proposal.requested"
  );
}

/** The standing reply for this request, if one matches it exactly and is of its kind. */
export function matchReply(replies: readonly StandingReply[], event: AskEvent): number {
  const fingerprint = event.payload.fingerprint;
  if (!fingerprint) return -1;
  const kind =
    event.type === "user-input.requested"
      ? "question"
      : event.type === "request.opened"
        ? "permission"
        : "proposal";
  return replies.findIndex((r) => r.kind === kind && r.fingerprint === fingerprint);
}

/** What part of a carry-on message is about checking, so nothing with side effects runs twice. */
const CHECK_FIRST =
  "Check what is already done and don't redo it (commits, pushes, comments, anything with side effects), then carry on from where you stopped.";

/**
 * What the daemon sends a thread whose turn it cut short by restarting (engine.ts): the agent
 * resumes its session and picks up where it was. Sent once; if this turn is cut short too, the
 * thread gets an error card instead.
 */
export const RESTART_PROMPT = `Tenzo restarted while you were working, which cut your last turn short. ${CHECK_FIRST}`;

/**
 * The prompts an answer to an error item sends. Tell it something sends your words. Retry
 * depends on what went wrong: prompts that never reached the agent (it couldn't start) go
 * again as they were; a turn that failed or was cut short already did part of its work, which
 * the resumed session's transcript shows, so it gets a message saying so (`carryOn`), never its
 * prompt again.
 */
export function errorPrompts(
  item: QueueItem,
  answer: Extract<ItemAnswer, { kind: "error" }>,
): string[] {
  if (answer.action === "tell") return [answer.text ?? ""];
  const error = item.error;
  // Retry on a config card reads the config again (engine.ts): nothing goes to the agent.
  if (error?.cause === "config") return [];
  const resend =
    error?.cause === "start" || error?.cause === "stalled" || error?.cause === "unarchived";
  if (resend && error.prompts.length > 0) return error.prompts;
  return [carryOn(error)];
}

/** The opening of a carry-on message: how to tell one when it is what a turn began with. */
const DIDNT_FINISH = "Your last turn didn't finish";
const BEGAN_WITH = /\nIt began with my message: "(.*)"\n/;

/**
 * The message a turn began with, as I first sent it: a carry-on (a retry of a retry) or a
 * restart's resume quotes the turn it picks up, not itself.
 */
function originalPrompt(prompt: string | undefined): string | undefined {
  if (prompt === undefined || prompt === RESTART_PROMPT) return undefined;
  if (!prompt.startsWith(DIDNT_FINISH)) return prompt;
  return BEGAN_WITH.exec(prompt)?.[1];
}

/** Retry for a turn that failed or was cut short: what happened, what it was, check first. */
export function carryOn(error: QueueItem["error"]): string {
  const asked = originalPrompt(error?.prompts[0]);
  return [
    error?.message
      ? `Your last turn didn't finish: ${oneLine(error.message, 400)}`
      : "Your last turn didn't finish.",
    ...(asked ? [`It began with my message: "${oneLine(asked, 300)}"`] : []),
    CHECK_FIRST,
  ].join("\n");
}

function oneLine(text: string, limit: number): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}

/**
 * The message that tells a resumed agent what it asked before it stopped, and the answer.
 * Finished work and ready PRs are never delivered this way: nothing waits on them, and the
 * engine sends their answers as ordinary messages (prompts.ts).
 */
export function deliveryPrompt(
  item: QueueItem,
  answer: Exclude<ItemAnswer, { kind: "finished" | "ready" }>,
): string {
  // The engine sends an error's answer as `errorPrompts`; here only for completeness.
  if (answer.kind === "error") return errorPrompts(item, answer).join("\n\n");
  if (answer.kind === "proposal") {
    const head = `Your session ended while you were waiting for my answer to your proposal: ${item.proposal?.headline ?? item.ask}`;
    return answer.decision === "build"
      ? `${head}\n${APPROVED} Carry on from where you left off.`
      : `${head}\nNot yet. ${answer.note ?? ""}\nRevise, and propose again.`;
  }
  if (answer.kind === "question") {
    const lines = item.questions.flatMap((q) => [
      `You asked: ${q.question || q.header}`,
      `My answer: ${labelOf(q, answer.answers[q.id] ?? "")}`,
      "",
    ]);
    return [
      "Your session ended while you were waiting for my answer, so here it is.",
      "",
      ...lines,
      "Carry on from where you left off.",
    ].join("\n");
  }
  const what = item.permission?.detail ?? item.ask;
  const head = `Your session ended while you were waiting for my permission for this: ${what}`;
  return answer.decision === "allow"
    ? `${head}\nI allow it. Go ahead, and carry on from where you left off.`
    : `${head}\nI don't allow it${answer.message ? `: ${answer.message}` : "."}\nDon't do it; carry on from where you left off without it.`;
}

/** An option's label for its value ("Blue (Recommended)" → "Blue"); free text as it is. */
function labelOf(q: UserInputQuestion, value: string): string {
  const labels = value.split(", ").map((v) => q.options.find((o) => o.value === v)?.label);
  return labels.every((l) => l !== undefined) ? labels.join(", ") : value;
}

/**
 * What the words after `tenzo answer <item>` mean. A question: a number picks an option, so
 * does its label; anything else is your own answer. Several questions take one argument each.
 * A permission request: `allow`/`y`/`1`, `deny`/`n`/`2`, or anything else to deny with that as
 * the reason.
 */
export function answerFromWords(item: QueueItem, words: readonly string[]): ItemAnswer {
  if (item.kind === "finished") {
    // Landing is never a reflex: only the word merge merges. y, yes and 1 still mean Done, as
    // they did before finished work could land.
    const text = words.join(" ").trim();
    if (/^merge$/i.test(text)) return { kind: "finished", decision: "merge" };
    if (/^(pr|open pr)$/i.test(text)) return { kind: "finished", decision: "pr" };
    if (/^(1|y|yes|done|ok)$/i.test(text)) return { kind: "finished", decision: "done" };
    if (text === "" || /^(\d+|n|no)$/i.test(text)) {
      throw new TenzoError("Answer with merge, pr or done, or say what needs changing.");
    }
    return { kind: "finished", decision: "changes", note: text };
  }
  if (item.kind === "ready") {
    const text = words.join(" ").trim();
    if (/^merge$/i.test(text)) return { kind: "ready", decision: "merge" };
    if (text === "" || /^(\d+|y|yes|n|no)$/i.test(text)) {
      throw new TenzoError("Answer with merge, or say what to do first.");
    }
    return { kind: "ready", decision: "changes", note: text };
  }
  if (item.kind === "error") {
    const text = words.join(" ").trim();
    if (/^(1|r|retry)$/i.test(text)) return { kind: "error", action: "retry" };
    if (/^(2|archive)$/i.test(text)) return { kind: "error", action: "archive" };
    if (text === "") throw new TenzoError("Answer with retry, archive, or what to tell it.");
    return { kind: "error", action: "tell", text };
  }
  if (item.kind === "proposal") {
    const text = words.join(" ").trim();
    if (/^(1|y|yes|build|build it)$/i.test(text)) return { kind: "proposal", decision: "build" };
    if (text === "") throw new TenzoError("Answer with build, or say what to change.");
    return { kind: "proposal", decision: "change", note: text };
  }
  if (item.kind === "permission") {
    const text = words.join(" ").trim();
    if (/^(1|y|yes|allow)$/i.test(text)) return { kind: "permission", decision: "allow" };
    if (text === "" || /^(2|n|no|deny)$/i.test(text)) {
      return { kind: "permission", decision: "deny" };
    }
    return { kind: "permission", decision: "deny", message: text };
  }
  const questions = item.questions;
  const replies = questions.length === 1 ? [words.join(" ")] : [...words];
  if (replies.length !== questions.length) {
    throw new TenzoError(
      `${item.id} asks ${questions.length} questions: give one answer for each, quoting answers with spaces.`,
    );
  }
  const answers: UserInputAnswers = {};
  questions.forEach((q, i) => {
    const reply = (replies[i] ?? "").trim();
    const picked = pick(q, reply);
    if (picked === undefined) {
      throw new TenzoError(
        reply === ""
          ? `"${q.question}" needs an answer.`
          : `"${reply}" isn't one of the ${q.options.length} options for "${q.question}".`,
      );
    }
    answers[q.id] = picked;
  });
  return { kind: "question", answers };
}

/** The answer a reply stands for; undefined when it's empty or picks an option that isn't there. */
export function pick(q: UserInputQuestion, reply: string): string | undefined {
  if (reply === "") return undefined;
  const byLabel = q.options.find((o) => o.label.toLowerCase() === reply.toLowerCase());
  if (byLabel) return byLabel.value;
  const numbers = reply.split(/\s*,\s*/);
  if (q.options.length === 0 || !numbers.every((n) => /^\d+$/.test(n))) return reply; // free text
  if (!q.multiSelect && numbers.length > 1) return undefined;
  const values = numbers.map((n) => q.options[Number(n) - 1]?.value);
  return values.every((v) => v !== undefined) ? values.join(", ") : undefined;
}
