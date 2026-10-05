import type {
  AgentKind,
  PermissionModeName,
  RequestId,
  RuntimeEvent,
  ThreadId,
  ThreadPhase,
  TurnId,
  UserInputAnswers,
} from "@tenzo/contracts";
import type { SessionModels } from "../project-config.ts";
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
  /**
   * The daemon ended the thread's last session to change its settings (`reconfigure` said
   * `restart`): what the conversation ran before is no guide to what this one should.
   */
  restarted?: boolean;
  /**
   * The models and thinking levels the thread runs with, per phase, Tenzo's precedence already
   * applied (project-config.ts): `discuss` while discussing, `build` from Build it on, `agents`
   * for subagents. Unset: the agent's own defaults (the user's config), as in their terminal.
   */
  models?: SessionModels;
  /**
   * The permission mode the project's config sets. Unset (the default): Tenzo sets none, and the
   * user's own `defaultMode` applies, as in their terminal.
   */
  permissionMode?: PermissionModeName;
  /** An automation run's spend cap (`SessionSettings.budget`). Unset: none, as in the terminal. */
  budget?: SpendBudget;
  /**
   * Where the thread is: which of Tenzo's thread prompts the session gets. Discussing: talk, don't
   * change anything yet. Building or review: build. The permission mode is never Tenzo's unless
   * the project's config sets one (`permissionMode`): the user's own settings decide it.
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
  /** The daemon, for the tools that need it (`start_thread`, phase checks). None: they refuse. */
  host?: SessionHost;
}

/**
 * What Tenzo chooses for a session: the models per phase, the permission mode if any, and for an
 * automation's run with a cost budget, what it may spend.
 */
export interface SessionSettings {
  models: SessionModels;
  permissionMode?: PermissionModeName | undefined;
  budget?: SpendBudget | undefined;
}

/**
 * What an automation's run may spend, in USD: `capUsd` in all, `spentUsd` of it already (by the
 * agent's own running total). The agent stops a turn of its own when the cap is reached, and
 * says so (`turn.completed` `stoppedBy: "budget"`). A new cap takes a new session.
 */
export interface SpendBudget {
  capUsd: number;
  spentUsd: number;
}

/** What a session asks of the daemon while it runs. */
export interface SessionHost {
  /**
   * Where the thread is now, by the daemon's log. It moves under a running session (Merge on
   * the finished card makes it landing), so the session asks instead of keeping its own.
   */
  phase(): ThreadPhase;
  /**
   * Checks, with git alone, that the thread's work has landed before `landed` is believed:
   * nothing uncommitted, and everything its branch changes is in the default branch on origin.
   * Throws a TenzoError saying what isn't so.
   */
  checkLanded(): Promise<void>;
  /**
   * Starts a thread on this one's behalf (origin `agent`, this thread its parent). Refused for
   * a thread an agent started, and past a few per thread: no fan-out.
   */
  startThread(input: {
    prompt: string;
    project?: string;
    title?: string;
  }): Promise<{ id: ThreadId; title: string; projectName: string; branch: string }>;
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
   * What the session should run with now (the thread's own choice or its project's config
   * changed, or the phase did). `unchanged`: nothing to do. A promise: it is switching in place,
   * settled once done (it never rejects); the daemon sends the next turn after it. `restart`: it
   * can't take it live and changed nothing; the daemon ends the session at the turn boundary
   * and starts it again with the new settings (`restarted`).
   */
  reconfigure(settings: SessionSettings): "unchanged" | "restart" | Promise<void>;
  /**
   * The agent has work running in the background (a background subagent, a background shell, a
   * Monitor) that ending the session would kill: the daemon doesn't restart it meanwhile.
   */
  readonly backgroundWork: boolean;
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
