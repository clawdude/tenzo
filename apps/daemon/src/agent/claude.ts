import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  type CanUseTool,
  type Options,
  type PermissionResult,
  query as sdkQuery,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  RequestId,
  RuntimeEvent,
  TurnId,
  UserInputAnswers,
  UserInputQuestion,
} from "@tenzo/contracts";
import { TenzoError } from "../errors.ts";
import { randomId } from "../ids.ts";
import type { AgentAdapter, AgentSession, EventDraft, StartSessionInput } from "./agent.ts";
import {
  type ClaudeTranslation,
  initialTranslation,
  startTurn,
  summarizeTool,
  toolKind,
  type Translated,
  translate,
} from "./claude-events.ts";
import { AsyncQueue } from "./queue.ts";

/**
 * Claude Code behind the agent boundary, through `@anthropic-ai/claude-agent-sdk`.
 *
 * Tenzo runs the user's own `claude` binary with the user's own configuration, untouched: user,
 * project and local settings, CLAUDE.md, subagents, skills, hooks, MCP servers and plugins all
 * load exactly as in the terminal, and the system prompt is Claude Code's own. Tenzo adds only
 * the permission mode (accept edits) and a `canUseTool` hook, which is how questions
 * (`AskUserQuestion`) and permission prompts reach the Pass instead of a terminal.
 */
export interface ClaudeAdapterOptions {
  /** The SDK's `query`. Tests pass a fake, so they never spawn Claude. */
  query?: typeof sdkQuery;
  /** Path to `claude`. Default: the first `claude` on PATH, looked up when a session starts. */
  claudePath?: string;
}

/** Every filesystem setting source, as the `claude` CLI itself loads them. */
export const SETTING_SOURCES = ["user", "project", "local"] as const;

/** How long `stop` waits for Claude to exit by itself before closing it. */
const STOP_GRACE_MS = 5000;

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): AgentAdapter {
  const query = options.query ?? sdkQuery;
  return {
    agent: "claude",
    start: (input) => startSession(query, options.claudePath ?? findClaude(), input),
  };
}

interface Pending {
  kind: "request" | "user-input";
  settle: (outcome: Settled) => void;
}

type Settled =
  | { kind: "request"; decision: "allow" | "deny" | "cancel"; message?: string }
  | { kind: "user-input"; answers: UserInputAnswers | null };

function startSession(
  query: typeof sdkQuery,
  claudePath: string,
  input: StartSessionInput,
): AgentSession {
  const resumed = input.resumeSessionId !== undefined;
  const sessionId = input.resumeSessionId ?? randomUUID();
  const events = new AsyncQueue<RuntimeEvent>();
  const prompts = new AsyncQueue<SDKUserMessage>();
  const pending = new Map<RequestId, Pending>();
  let state: ClaudeTranslation = initialTranslation({ resumed });

  const emit = (draft: EventDraft): void => {
    events.push({
      ...draft,
      eventId: randomId("evt"),
      threadId: input.threadId,
      agent: "claude",
      createdAt: new Date().toISOString(),
    } as RuntimeEvent);
  };
  const apply = (translated: Translated): void => {
    state = translated.state;
    for (const draft of translated.events) emit(draft);
  };
  const inTurn = (): { turnId?: TurnId } => (state.turnId ? { turnId: state.turnId } : {});

  /** Waits for an answer to a request; an abort (interrupt, stop) settles it as cancelled. */
  const waitFor = (requestId: RequestId, kind: Pending["kind"], signal: AbortSignal) =>
    new Promise<Settled>((resolve) => {
      const cancelled: Settled =
        kind === "request" ? { kind, decision: "cancel" } : { kind, answers: null };
      const settle = (outcome: Settled) => {
        if (!pending.delete(requestId)) return;
        signal.removeEventListener("abort", onAbort);
        resolve(outcome);
      };
      const onAbort = () => settle(cancelled);
      pending.set(requestId, { kind, settle });
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });

  const askUser = async (
    toolInput: Record<string, unknown>,
    signal: AbortSignal,
    toolUseID: string,
  ): Promise<PermissionResult> => {
    const requestId = randomId("req");
    const questions = parseQuestions(toolInput);
    emit({
      type: "user-input.requested",
      requestId,
      ...inTurn(),
      payload: { questions, itemId: toolUseID },
    });
    const outcome = await waitFor(requestId, "user-input", signal);
    const answers = outcome.kind === "user-input" ? outcome.answers : null;
    emit({
      type: "user-input.resolved",
      requestId,
      ...inTurn(),
      payload: { answers: answers ?? {}, cancelled: answers === null },
    });
    if (answers === null) return { behavior: "deny", message: "The user did not answer." };
    return { behavior: "allow", updatedInput: { ...toolInput, answers } };
  };

  const canUseTool: CanUseTool = async (toolName, toolInput, context) => {
    if (toolName === "AskUserQuestion") {
      return askUser(toolInput, context.signal, context.toolUseID);
    }

    const requestId = randomId("req");
    emit({
      type: "request.opened",
      requestId,
      ...inTurn(),
      payload: {
        toolKind: toolKind(toolName),
        toolName,
        detail: summarizeTool(toolName, toolInput),
        ...(context.title ? { title: context.title } : {}),
        ...(context.decisionReason ? { reason: context.decisionReason } : {}),
        input: toolInput,
        itemId: context.toolUseID,
      },
    });
    const outcome = await waitFor(requestId, "request", context.signal);
    const decision = outcome.kind === "request" ? outcome.decision : "cancel";
    const message = outcome.kind === "request" ? outcome.message : undefined;
    emit({
      type: "request.resolved",
      requestId,
      ...inTurn(),
      payload: { decision, ...(message ? { message } : {}) },
    });
    if (decision === "allow") return { behavior: "allow", updatedInput: toolInput };
    return {
      behavior: "deny",
      message: message || (decision === "cancel" ? "Cancelled." : "The user denied this."),
    };
  };

  const options: Options = {
    cwd: input.cwd,
    pathToClaudeCodeExecutable: claudePath,
    settingSources: [...SETTING_SOURCES],
    // Claude Code's own system prompt. Without this the SDK would run with a minimal one.
    systemPrompt: { type: "preset", preset: "claude_code" },
    permissionMode: "acceptEdits",
    canUseTool,
    ...(resumed ? { resume: sessionId } : { sessionId }),
    ...(input.model ? { model: input.model } : {}),
  };

  const run = query({ prompt: prompts, options });

  const cancelPending = () => {
    for (const { kind, settle } of [...pending.values()]) {
      settle(kind === "request" ? { kind, decision: "cancel" } : { kind, answers: null });
    }
  };

  let stopping = false;
  const done = (async () => {
    try {
      for await (const message of run) apply(translate(state, message));
      emit({ type: "session.exited", ...inTurn(), payload: { exitKind: "graceful" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (stopping) {
        // We asked it to end. Claude exits with code 1 when its input closes after an
        // interrupted turn; that is how it stopped, not something that went wrong.
        emit({ type: "session.exited", payload: { exitKind: "graceful", reason: message } });
        return;
      }
      // The SDK's message already ends with the tail of Claude's stderr, when there was any.
      emit({ type: "runtime.error", ...inTurn(), payload: { message } });
      emit({
        type: "session.exited",
        ...inTurn(),
        payload: { exitKind: "error", reason: message },
      });
    } finally {
      prompts.close();
      cancelPending();
      events.close();
    }
  })();

  const answer = (requestId: RequestId, outcome: Settled): void => {
    const open = pending.get(requestId);
    if (!open || open.kind !== outcome.kind) {
      const what = outcome.kind === "request" ? "permission request" : "question";
      throw new TenzoError(`No open ${what} "${requestId}".`);
    }
    open.settle(outcome);
  };

  return {
    threadId: input.threadId,
    sessionId,
    events,
    sendTurn(prompt) {
      if (prompts.closed) throw new TenzoError("This session has ended.");
      if (state.turnId !== null) throw new TenzoError("A turn is already running.");
      const turnId: TurnId = randomUUID();
      apply(startTurn(state, turnId, prompt));
      // The prompt's uuid is the turn id: Claude echoes it on the turn's replies and result.
      prompts.push({
        type: "user",
        message: { role: "user", content: prompt },
        parent_tool_use_id: null,
        uuid: turnId as SDKUserMessage["uuid"] & string,
      });
      return turnId;
    },
    respondToRequest(requestId, decision, message) {
      answer(requestId, { kind: "request", decision, ...(message ? { message } : {}) });
    },
    respondToUserInput(requestId, answers) {
      answer(requestId, { kind: "user-input", answers });
    },
    async interrupt() {
      cancelPending();
      await run.interrupt().catch(() => {}); // already finished: nothing to interrupt
    },
    async stop() {
      stopping = true;
      prompts.close(); // end of input: Claude finishes and exits
      cancelPending();
      let timer: NodeJS.Timeout | undefined;
      const exited = await Promise.race([
        done.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), STOP_GRACE_MS);
        }),
      ]);
      clearTimeout(timer);
      if (!exited) run.close();
      await done;
    },
  };
}

/** `AskUserQuestion`'s input as Tenzo questions. Claude keys each answer by its question text. */
export function parseQuestions(input: Record<string, unknown>): UserInputQuestion[] {
  const raw = Array.isArray(input.questions) ? input.questions : [];
  return raw.map((q: unknown, index): UserInputQuestion => {
    const r = isRecord(q) ? q : {};
    const question = typeof r.question === "string" ? r.question : "";
    const options = Array.isArray(r.options) ? r.options : [];
    return {
      id: question || `q${index + 1}`,
      header: typeof r.header === "string" ? r.header : "",
      question,
      options: options.filter(isRecord).map((o) => ({
        label: typeof o.label === "string" ? o.label : "",
        description: typeof o.description === "string" ? o.description : "",
      })),
      multiSelect: r.multiSelect === true,
    };
  });
}

/** The first executable `claude` on PATH: the user's own install, with the user's own login. */
export function findClaude(path = process.env.PATH ?? ""): string {
  for (const dir of path.split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, "claude");
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // not here
    }
  }
  throw new TenzoError(
    "Can't find `claude` on PATH. Install Claude Code and sign in (`claude`), then try again.",
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
