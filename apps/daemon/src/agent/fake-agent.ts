import { randomUUID } from "node:crypto";
import type {
  Attachment,
  Check,
  RequestId,
  RuntimeEvent,
  ThreadId,
  TurnId,
  UserInputAnswers,
  UserInputQuestion,
} from "@tenzo/contracts";
import { TenzoError } from "../errors.ts";
import { randomId } from "../ids.ts";
import type { AgentAdapter, AgentSession, EventDraft, StartSessionInput } from "./agent.ts";
import { boundedInput, summarizeTool } from "./claude-events.ts";
import { fingerprintOf } from "./fingerprint.ts";
import { AsyncQueue } from "./queue.ts";
import { PROPOSE, tenzoToolName } from "./tenzo-mcp.ts";

/**
 * Test-only: an agent adapter a test drives by hand. Each session reports what the test tells it
 * to (`say`, `ask`, `askPermission`, `propose`, `report`, `attach`, `expose`, `complete`,
 * `crash`) and records the prompts and answers it
 * gets, keeping the adapter contract: one turn at a time, answers only to open requests, no
 * `*.resolved` after the session ends.
 */
export class FakeAdapter implements AgentAdapter {
  readonly agent = "claude" as const;
  readonly sessions: FakeSession[] = [];
  /** Called for each session as it starts. */
  onStart: ((session: FakeSession) => void) | undefined;
  /** When set, `start` throws it (claude not installed, …). */
  failWith: Error | undefined;

  start(input: StartSessionInput): FakeSession {
    if (this.failWith) throw this.failWith;
    const session = new FakeSession(input);
    this.sessions.push(session);
    this.onStart?.(session);
    return session;
  }

  get last(): FakeSession {
    const session = this.sessions.at(-1);
    if (!session) throw new Error("no session started");
    return session;
  }
}

export interface Answered {
  requestId: RequestId;
  answers?: UserInputAnswers;
  decision?: "allow" | "deny" | "build" | "change";
  message?: string;
  note?: string;
}

export class FakeSession implements AgentSession {
  readonly threadId: ThreadId;
  readonly sessionId: string;
  readonly input: StartSessionInput;
  readonly events = new AsyncQueue<RuntimeEvent>();
  readonly prompts: string[] = [];
  readonly answered: Answered[] = [];
  readonly pending = new Map<RequestId, "question" | "permission" | "proposal">();
  turnId: TurnId | null = null;
  stopped = false;
  #ended = false;
  /** Called after each prompt is taken, with its turn already started. */
  onPrompt: ((prompt: string, turnId: TurnId) => void) | undefined;

  constructor(input: StartSessionInput) {
    this.input = input;
    this.threadId = input.threadId;
    this.sessionId = input.resumeSessionId ?? randomUUID();
    this.emit({
      type: "session.started",
      payload: { sessionId: this.sessionId, resumed: input.resumeSessionId !== undefined },
    });
  }

  get ended(): boolean {
    return this.#ended;
  }

  emit(draft: EventDraft): void {
    this.events.push({
      ...draft,
      eventId: randomId("evt"),
      threadId: this.threadId,
      agent: "claude",
      createdAt: new Date().toISOString(),
    } as RuntimeEvent);
  }

  #inTurn(): { turnId?: TurnId } {
    return this.turnId ? { turnId: this.turnId } : {};
  }

  sendTurn(prompt: string): TurnId {
    if (this.#ended) throw new TenzoError("This session has ended.");
    if (this.turnId) throw new TenzoError("A turn is already running.");
    const turnId = randomUUID() as TurnId;
    this.turnId = turnId;
    this.prompts.push(prompt);
    this.emit({ type: "turn.started", turnId, payload: { prompt } });
    queueMicrotask(() => this.onPrompt?.(prompt, turnId));
    return turnId;
  }

  say(text: string): void {
    this.emit({
      type: "item.completed",
      ...this.#inTurn(),
      itemId: randomUUID(),
      payload: { itemType: "assistant_message", status: "completed", text },
    });
  }

  ask(questions: UserInputQuestion[]): RequestId {
    const requestId = randomId("req");
    this.pending.set(requestId, "question");
    this.emit({
      type: "user-input.requested",
      ...this.#inTurn(),
      requestId,
      payload: { questions, fingerprint: fingerprintOf("AskUserQuestion", { questions }) },
    });
    return requestId;
  }

  /** Like Claude's adapter: the event shows a cut-down input, the fingerprint covers all of it. */
  askPermission(toolName: string, input: Record<string, unknown>): RequestId {
    const requestId = randomId("req");
    this.pending.set(requestId, "permission");
    this.emit({
      type: "request.opened",
      ...this.#inTurn(),
      requestId,
      payload: {
        toolKind: toolName === "Bash" ? "command" : "tool",
        toolName,
        detail: summarizeTool(toolName, input),
        input: boundedInput(input),
        fingerprint: fingerprintOf(toolName, input),
      },
    });
    return requestId;
  }

  /** Like Claude calling Tenzo's `propose`: a proposal that waits for Build it or a note. */
  propose(summary: string, headline = summary.split(".")[0] ?? summary): RequestId {
    const requestId = randomId("req");
    this.pending.set(requestId, "proposal");
    this.emit({
      type: "proposal.requested",
      ...this.#inTurn(),
      requestId,
      payload: {
        headline,
        summary,
        fingerprint: fingerprintOf(tenzoToolName(PROPOSE), { summary, headline }),
      },
    });
    return requestId;
  }

  /** Like Claude calling Tenzo's `report`: finished work, nothing waits on it. */
  report(
    summary: string,
    extra: { headline?: string; howToTest?: string; checks?: Check[] } = {},
  ): RequestId {
    const requestId = randomId("req");
    this.emit({
      type: "report.submitted",
      ...this.#inTurn(),
      requestId,
      payload: {
        ...(extra.headline ? { headline: extra.headline } : {}),
        summary,
        howToTest: extra.howToTest ?? "",
        checks: extra.checks ?? [],
      },
    });
    return requestId;
  }

  /** Like Claude calling Tenzo's `attach`, once the copy is made. */
  attach(attachment: Attachment): void {
    this.emit({ type: "attachment.added", ...this.#inTurn(), payload: { attachment } });
  }

  /** Like Claude calling Tenzo's `expose`, once the port answered. */
  expose(port: number, path = ""): void {
    this.emit({ type: "preview.exposed", ...this.#inTurn(), payload: { port, path } });
  }

  complete(state: "completed" | "failed" | "interrupted" = "completed"): void {
    if (!this.turnId) throw new Error("no turn to complete");
    this.emit({ type: "turn.completed", turnId: this.turnId, payload: { state } });
    this.turnId = null;
  }

  respondToUserInput(requestId: RequestId, answers: UserInputAnswers): void {
    if (this.pending.get(requestId) !== "question") {
      throw new TenzoError(`No open question "${requestId}".`);
    }
    this.pending.delete(requestId);
    this.answered.push({ requestId, answers });
    this.emit({
      type: "user-input.resolved",
      ...this.#inTurn(),
      requestId,
      payload: { answers, cancelled: false },
    });
  }

  respondToRequest(requestId: RequestId, decision: "allow" | "deny", message?: string): void {
    if (this.pending.get(requestId) !== "permission") {
      throw new TenzoError(`No open permission request "${requestId}".`);
    }
    this.pending.delete(requestId);
    this.answered.push({ requestId, decision, ...(message ? { message } : {}) });
    this.emit({
      type: "request.resolved",
      ...this.#inTurn(),
      requestId,
      payload: { decision, ...(message ? { message } : {}) },
    });
  }

  respondToProposal(requestId: RequestId, decision: "build" | "change", note?: string): void {
    if (this.pending.get(requestId) !== "proposal") {
      throw new TenzoError(`No open proposal "${requestId}".`);
    }
    this.pending.delete(requestId);
    this.answered.push({ requestId, decision, ...(note ? { note } : {}) });
    this.emit({
      type: "proposal.resolved",
      ...this.#inTurn(),
      requestId,
      payload: { decision, ...(note ? { note } : {}) },
    });
  }

  async interrupt(): Promise<void> {
    for (const [requestId, kind] of this.pending) {
      const turn = this.#inTurn();
      this.emit(
        kind === "question"
          ? { type: "user-input.resolved", ...turn, requestId, payload: { answers: {}, cancelled: true } }
          : kind === "proposal"
            ? { type: "proposal.resolved", ...turn, requestId, payload: { decision: "cancel" } }
            : { type: "request.resolved", ...turn, requestId, payload: { decision: "cancel" } },
      );
    }
    this.pending.clear();
    if (this.turnId) this.complete("interrupted");
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.#end("graceful");
  }

  /** The process dies: open requests are left as they are, the stream ends. */
  crash(reason = "boom"): void {
    this.#end("error", reason);
  }

  #end(exitKind: "graceful" | "error", reason?: string): void {
    if (this.#ended) return;
    this.#ended = true;
    this.pending.clear();
    this.emit({
      type: "session.exited",
      ...this.#inTurn(),
      payload: { exitKind, ...(reason ? { reason } : {}) },
    });
    this.turnId = null;
    this.events.close();
  }
}
