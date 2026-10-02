import type {
  RuntimeEvent,
  RuntimeEventOf,
  TurnState,
  UserInputAnswers,
  UserInputQuestion,
} from "@tenzo/contracts";
import type { AgentAdapter, AgentSession } from "./agent/agent.ts";
import { TenzoError } from "./errors.ts";
import type { Thread } from "./threads.ts";

/**
 * Runs one turn of a thread from the command line: starts (or resumes) the agent in the thread's
 * worktree, sends the prompt, prints every event, and asks the person at the keyboard whenever
 * the agent has a question or wants permission. A stand-in until the daemon (#6) and the Pass
 * (#8) take over the answering.
 */
export interface RunTurnInput {
  adapter: AgentAdapter;
  thread: Thread;
  prompt: string;
  model?: string;
  /** Called with the agent's session id as soon as it is known, so it can be stored. */
  onSession(sessionId: string): void;
  /** Shows `prompt` and resolves with the next line typed, or null at end of input. */
  ask(prompt: string): Promise<string | null>;
  /** Writes one line of output. */
  print(line: string): void;
  /** Print events as JSON lines instead of one readable line each. */
  json?: boolean;
  /** Lets the caller interrupt (first call) or stop the session (Ctrl-C). */
  onStarted?(session: AgentSession): void;
}

export interface RunTurnResult {
  sessionId: string;
  /** How the turn ended; undefined if the session ended first (crash, stop). */
  state: TurnState | undefined;
}

export async function runTurn(input: RunTurnInput): Promise<RunTurnResult> {
  const session = input.adapter.start({
    threadId: input.thread.id,
    cwd: input.thread.worktreePath,
    ...(input.thread.sessionId ? { resumeSessionId: input.thread.sessionId } : {}),
    ...(input.model ? { model: input.model } : {}),
  });
  input.onStarted?.(session);
  let state: TurnState | undefined;
  try {
    session.sendTurn(input.prompt);
    for await (const event of session.events) {
      input.print(input.json ? JSON.stringify(event) : formatEvent(event));
      switch (event.type) {
        case "session.started":
          input.onSession(event.payload.sessionId);
          break;
        case "user-input.requested": {
          const answers = await askQuestions(event.payload.questions, input.ask);
          if (answers === null)
            await session.interrupt(); // end of input: nobody to answer
          else ifStillOpen(() => session.respondToUserInput(event.requestId, answers));
          break;
        }
        case "request.opened": {
          const reply = await input.ask(
            `? Allow ${event.payload.detail}? [y]es, [n]o, or type why not: `,
          );
          if (reply === null) await session.interrupt();
          else ifStillOpen(() => respond(session, event, reply));
          break;
        }
        case "turn.completed":
          state = event.payload.state;
          await session.stop();
          break;
      }
    }
  } finally {
    await session.stop();
  }
  return { sessionId: session.sessionId, state };
}

/** `y` allows; `n` or nothing denies; anything else denies with that as the reason. */
function respond(session: AgentSession, event: RuntimeEventOf<"request.opened">, reply: string) {
  const answer = reply.trim();
  if (/^(y|yes)$/i.test(answer)) {
    session.respondToRequest(event.requestId, "allow");
  } else {
    const reason = answer === "" || /^(n|no)$/i.test(answer) ? undefined : answer;
    session.respondToRequest(event.requestId, "deny", reason);
  }
}

/** Answers unless the request was cancelled while we asked (Ctrl-C): then there's nothing to do. */
function ifStillOpen(answer: () => void): void {
  try {
    answer();
  } catch (error) {
    if (!(error instanceof TenzoError)) throw error;
  }
}

/** A thread's title from its first prompt: the first line, cut at a word near 80 characters. */
export function titleFrom(prompt: string): string {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  if (line.length <= 80) return line;
  const space = line.lastIndexOf(" ", 80);
  return `${line.slice(0, space > 40 ? space : 80)}…`;
}

/** Asks each question in turn. A number picks an option; anything else is the answer itself. */
export async function askQuestions(
  questions: readonly UserInputQuestion[],
  ask: (prompt: string) => Promise<string | null>,
): Promise<UserInputAnswers | null> {
  const answers: UserInputAnswers = {};
  for (const q of questions) {
    const lines = [
      `? ${q.question}${q.header ? `  [${q.header}]` : ""}`,
      ...q.options.map(
        (o, i) =>
          `  ${i + 1}. ${o.label}${o.recommended ? " (recommended)" : ""}${o.description ? ` — ${o.description}` : ""}`,
      ),
      q.multiSelect
        ? "  Numbers separated by commas, or type your own answer: "
        : "  A number, or type your own answer: ",
    ];
    let answer: string | undefined;
    while (answer === undefined) {
      const reply = await ask(lines.join("\n"));
      if (reply === null) return null;
      answer = pick(q, reply.trim());
    }
    answers[q.id] = answer;
  }
  return answers;
}

/** The answer a reply stands for; undefined when it's empty or picks an option that isn't there. */
function pick(q: UserInputQuestion, reply: string): string | undefined {
  if (reply === "") return undefined;
  const numbers = reply.split(/\s*,\s*/);
  if (!numbers.every((n) => /^\d+$/.test(n))) return reply; // free text
  if (!q.multiSelect && numbers.length > 1) return undefined;
  const labels = numbers.map((n) => q.options[Number(n) - 1]?.label);
  return labels.every((l) => l !== undefined) ? labels.join(", ") : undefined;
}

/** One readable line per event: its type, then what it says. */
export function formatEvent(event: RuntimeEvent): string {
  return `${event.type.padEnd(21)}${describe(event)}`;
}

function describe(event: RuntimeEvent): string {
  switch (event.type) {
    case "session.started":
      return `${event.payload.sessionId}${event.payload.resumed ? " (resumed)" : ""}`;
    case "session.configured": {
      const p = event.payload;
      return [
        p.model,
        `Claude Code ${p.agentVersion}`,
        p.permissionMode,
        `${p.tools.length} tools`,
        `${p.mcpServers.length} MCP`,
        `${p.skills.length} skills`,
        `${p.plugins.length} plugins`,
        `${p.agents.length} agents`,
      ].join(" · ");
    }
    case "session.exited":
      return event.payload.exitKind + (event.payload.reason ? `: ${event.payload.reason}` : "");
    case "turn.started":
      return event.payload.prompt === undefined
        ? "(started by the agent)"
        : quote(event.payload.prompt);
    case "turn.completed": {
      const p = event.payload;
      return [
        p.state,
        p.costUsd === undefined ? undefined : `$${p.costUsd.toFixed(4)}`,
        p.durationMs === undefined ? undefined : `${(p.durationMs / 1000).toFixed(1)}s`,
        p.errorMessage,
      ]
        .filter(Boolean)
        .join(" · ");
    }
    case "item.started":
    case "item.completed": {
      const p = event.payload;
      const status =
        p.status === "failed"
          ? "✗ "
          : event.type === "item.completed" && p.itemType === "tool"
            ? "✓ "
            : "";
      const who =
        p.itemType === "user_message"
          ? "you: "
          : p.itemType === "assistant_message"
            ? "claude: "
            : p.itemType === "reasoning"
              ? "thinking: "
              : "";
      const sub = p.parentItemId ? "  ↳ " : "";
      return `${sub}${status}${who}${oneLine(p.text ?? "", 160)}`;
    }
    case "request.opened":
      return `${event.payload.detail}${event.payload.reason ? ` (${event.payload.reason})` : ""}`;
    case "request.resolved":
      return event.payload.decision + (event.payload.message ? `: ${event.payload.message}` : "");
    case "user-input.requested":
      return event.payload.questions
        .map((q) => `${q.question} [${q.options.map((o) => o.label).join(" / ")}]`)
        .join("; ");
    case "user-input.resolved":
      return event.payload.cancelled ? "cancelled" : JSON.stringify(event.payload.answers);
    case "runtime.error":
      return event.payload.message;
  }
}

function quote(text: string): string {
  return `"${oneLine(text, 120)}"`;
}

function oneLine(text: string, limit: number): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
