import type {
  AgentKind,
  RequestId,
  RuntimeEvent,
  ThreadId,
  ThreadPhase,
  TurnId,
  UserInputAnswers,
} from "@tenzo/contracts";
import type { ThreadPrompts } from "../prompts.ts";

/**
 * The boundary between Tenzo and a coding agent. Everything agent-specific (SDK messages, the
 * agent's permission protocol, how it asks questions) stays behind it; above it there are only
 * runtime events and these few calls. Claude implements it now, Codex in M5.
 */
export interface AgentAdapter {
  readonly agent: AgentKind;
  /** Starts the agent in `cwd`, or continues an earlier session. No turn runs until `sendTurn`. */
  start(input: StartSessionInput): AgentSession;
}

export interface StartSessionInput {
  threadId: ThreadId;
  /** The thread's worktree. */
  cwd: string;
  /** The agent's session id from an earlier run (`AgentSession.sessionId`): continue it. */
  resumeSessionId?: string;
  /** A model name the agent understands, e.g. "haiku". Default: the agent's own default. */
  model?: string;
  /**
   * Where the thread is: which of Tenzo's thread prompts the session gets. Discussing: talk, don't
   * change anything yet. Building or review: build. The permission mode is never Tenzo's: the
   * user's own settings decide it, in every phase.
   */
  phase: ThreadPhase;
  /** Where `attach` keeps its copies (`<home>/attachments/<thread>`). None: attach refuses. */
  attachmentsDir?: string;
  /** Screenshots the thread already holds for its next report: they count against the cap. */
  pendingAttachments?: number;
  /**
   * Tenzo's thread prompts: the one for `phase` is appended to the agent's own system prompt,
   * and an approved proposal carries the build prompt (prompts.ts). None: nothing is appended.
   */
  prompts?: ThreadPrompts;
}

/** One running agent process for one thread. */
export interface AgentSession {
  readonly threadId: ThreadId;
  /** The agent's own id for this conversation. Store it to resume after a restart. */
  readonly sessionId: string;
  /** Every event of the session in order; ends when the session does. Read it once. */
  readonly events: AsyncIterable<RuntimeEvent>;
  /** Sends a prompt and starts a turn. One turn at a time: throws while one is running. */
  sendTurn(prompt: string): TurnId;
  /** Answers a `request.opened`. A `deny` message goes back to the agent as the reason. */
  respondToRequest(requestId: RequestId, decision: "allow" | "deny", message?: string): void;
  /** Answers a `user-input.requested`, one answer per question id. */
  respondToUserInput(requestId: RequestId, answers: UserInputAnswers): void;
  /**
   * Answers a `proposal.requested`: build it (the agent goes ahead, with the build prompt), or
   * change something, with a note saying what. The agent's `propose` call returns with it.
   */
  respondToProposal(requestId: RequestId, decision: "build" | "change", note?: string): void;
  /**
   * Stops the running turn; the session stays up for the next one. Open questions and requests
   * are cancelled (`*.resolved` with cancel).
   */
  interrupt(): Promise<void>;
  /**
   * Ends the session and its process. Open questions and requests are left unanswered: no
   * `*.resolved` follows, and `session.exited` means nothing waits on them any more. The same
   * holds when the process ends by itself. (The daemon keeps them as detached items.)
   */
  stop(): Promise<void>;
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An event before the adapter stamps its id, thread, agent and time on it. */
export type EventDraft = DistributiveOmit<
  RuntimeEvent,
  "eventId" | "threadId" | "agent" | "createdAt"
>;
