import { randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
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
  ThreadPhase,
  TurnId,
  UserInputAnswers,
  UserInputQuestion,
} from "@tenzo/contracts";
import { liveBase, WebUrl } from "@tenzo/contracts";
import { MAX_ATTACHMENTS, takeAttachment } from "../attachments.ts";
import { TenzoError } from "../errors.ts";
import { hasChanges } from "../git.ts";
import { randomId } from "../ids.ts";
import {
  checkListener,
  checkPort,
  type ListenerDirs,
  livePath,
  lsofListenerDirs,
  probeLive,
} from "../live.ts";
import { promptFor, proposalReply, wakePrompt } from "../prompts.ts";
import type { AgentAdapter, AgentSession, EventDraft, StartSessionInput } from "./agent.ts";
import {
  boundedInput,
  type ClaudeTranslation,
  initialTranslation,
  startTurn,
  summarizeTool,
  toolKind,
  type Translated,
  translate,
} from "./claude-events.ts";
import { fingerprintOf } from "./fingerprint.ts";
import { AsyncQueue } from "./queue.ts";
import {
  type AttachInput,
  type ExposeInput,
  isTenzoTool,
  type LandedInput,
  PROPOSE,
  type ProposeInput,
  parseWait,
  proposalOf,
  type ReadyInput,
  type ReportInput,
  reportOf,
  type StartThreadInput,
  TENZO_MCP_SERVER,
  type TenzoToolHost,
  type ToolReply,
  tenzoMcpServer,
  tenzoToolName,
  type WakeInput,
} from "./tenzo-mcp.ts";

/**
 * Claude Code behind the agent boundary, through `@anthropic-ai/claude-agent-sdk`.
 *
 * Tenzo runs the user's own `claude` binary with the user's own configuration, untouched: user,
 * project and local settings, CLAUDE.md, subagents, skills, hooks, MCP servers and plugins all
 * load exactly as in the terminal, and the system prompt is Claude Code's own. Tenzo adds:
 * - its thread prompt for the phase, appended to Claude Code's (prompts.ts);
 * - its own MCP server, `tenzo`, next to the user's (tenzo-mcp.ts), whose `propose` waits for
 *   your decision the way a permission prompt does;
 * - a `canUseTool` hook, which is how questions (`AskUserQuestion`) and permission prompts reach
 *   the Pass instead of a terminal.
 *
 * It never sets the permission mode, in any phase: the user's own `defaultMode` (from their user,
 * project or local settings) applies, as in their terminal. Discussing is held by the discuss
 * prompt and `propose`, not by a mode.
 */
export interface ClaudeAdapterOptions {
  /** The SDK's `query`. Tests pass a fake, so they never spawn Claude. */
  query?: typeof sdkQuery;
  /** Path to `claude`. Default: the first `claude` on PATH, looked up when a session starts. */
  claudePath?: string;
  /**
   * The working directories of the processes listening on a port, for `expose` (live.ts).
   * Default: asked of `lsof`. Tests pass a stand-in.
   */
  listenerDirs?: ListenerDirs;
}

/** Every filesystem setting source, as the `claude` CLI itself loads them. */
export const SETTING_SOURCES = ["user", "project", "local"] as const;

/** Threads one session may start with `start_thread`: enough for real work, not a runaway loop. */
export const MAX_STARTED_THREADS = 10;

/** How long `stop` waits for Claude to exit by itself before closing it. */
const STOP_GRACE_MS = 5000;

export function createClaudeAdapter(options: ClaudeAdapterOptions = {}): AgentAdapter {
  const query = options.query ?? sdkQuery;
  return {
    agent: "claude",
    start: (input) =>
      startSession(query, options.claudePath ?? findClaude(), input, options.listenerDirs ?? lsofListenerDirs),
  };
}

interface Pending {
  kind: "request" | "user-input" | "proposal";
  settle: (outcome: Settled) => void;
}

/**
 * How a pending request ended. `ended`: the session stopped or its process exited, so nobody
 * answered and no `*.resolved` event is emitted; `session.exited` says it (the request outlives
 * the process as a detached item, see engine.ts).
 */
type Settled =
  | { kind: "request"; decision: "allow" | "deny" | "cancel"; message?: string; ended?: true }
  | { kind: "user-input"; answers: UserInputAnswers | null; ended?: true }
  | { kind: "proposal"; decision: "build" | "change" | "cancel"; note?: string; ended?: true };

/** How a request of `kind` ends when nobody answers it: cancelled, or `ended` with the session. */
function unanswered(kind: Pending["kind"], ended: boolean): Settled {
  const flag = ended ? { ended: true as const } : {};
  switch (kind) {
    case "request":
      return { kind, decision: "cancel", ...flag };
    case "user-input":
      return { kind, answers: null, ...flag };
    case "proposal":
      return { kind, decision: "cancel", ...flag };
  }
}

function startSession(
  query: typeof sdkQuery,
  claudePath: string,
  input: StartSessionInput,
  listenerDirs: ListenerDirs,
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
      const cancelled = unanswered(kind, false);
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
      payload: {
        questions,
        itemId: toolUseID,
        fingerprint: fingerprintOf("AskUserQuestion", toolInput),
      },
    });
    const outcome = await waitFor(requestId, "user-input", signal);
    if (outcome.ended) return { behavior: "deny", message: "The session ended." };
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

  /**
   * `propose`: the proposal becomes an item, and the tool call returns only once you've decided,
   * like a permission prompt. One at a time: a second while one waits (parallel calls, a
   * subagent) is turned away, so there is never more than one proposal card per thread.
   */
  const propose = async (raw: ProposeInput, signal: AbortSignal | undefined): Promise<ToolReply> => {
    if ([...pending.values()].some((p) => p.kind === "proposal")) {
      return {
        text: "A proposal is already waiting for the person's answer. Wait for that one instead of proposing again.",
        isError: true,
      };
    }
    const requestId = randomId("req");
    emit({
      type: "proposal.requested",
      requestId,
      ...inTurn(),
      payload: { ...proposalOf(raw), fingerprint: fingerprintOf(tenzoToolName(PROPOSE), raw) },
    });
    const outcome = await waitFor(requestId, "proposal", signal ?? new AbortController().signal);
    if (outcome.ended) return { text: "The session ended.", isError: true };
    const decision = outcome.kind === "proposal" ? outcome.decision : "cancel";
    const note = outcome.kind === "proposal" ? outcome.note : undefined;
    emit({
      type: "proposal.resolved",
      requestId,
      ...inTurn(),
      payload: { decision, ...(note ? { note } : {}) },
    });
    if (decision === "cancel") return { text: "Withdrawn: the turn was interrupted.", isError: true };
    if (decision === "change") {
      return { text: proposalReply({ decision, note: note ?? "" }, input.prompts) };
    }
    // The approval carries the build prompt; the permission mode stays the user's own.
    phase = "building";
    return { text: proposalReply({ decision }, input.prompts) };
  };
  /** Where this session's thread is: discussing until a proposal is approved. */
  let phase = input.phase;
  /**
   * Where the thread is now: the daemon's log says (your answers move it under a running
   * session), except that an approval in this session is a moment ahead of it.
   */
  const phaseNow = (): ThreadPhase => {
    const daemon = input.host?.phase();
    return daemon && daemon !== "discussing" ? daemon : phase;
  };

  /**
   * `report`: finished work becomes a review item at once, with what was attached and exposed
   * before it. Nothing waits for you: a review can take hours, and your answer comes back to the
   * thread as a message (#21), as any follow-up does.
   */
  let attached = input.pendingAttachments ?? 0;
  const report = async (raw: ReportInput): Promise<ToolReply> => {
    if (phaseNow() === "discussing") {
      return {
        text: "Nothing to report yet: propose first, and report once the approved work is built.",
        isError: true,
      };
    }
    emit({ type: "report.submitted", requestId: randomId("req"), ...inTurn(), payload: reportOf(raw) });
    attached = 0;
    return {
      text: "Reported: the person has your card. End your turn now with one short line; their answer comes back to you as a message.",
    };
  };

  /** `attach`: a copy of a screenshot from the worktree, for the next report (attachments.ts). */
  const attach = async (raw: AttachInput): Promise<ToolReply> => {
    if (!input.attachmentsDir) return { text: "This thread takes no attachments.", isError: true };
    if (attached >= MAX_ATTACHMENTS) {
      return { text: `A report carries at most ${MAX_ATTACHMENTS} screenshots.`, isError: true };
    }
    return toolCall(async () => {
      const attachment = await takeAttachment({
        worktree: input.cwd,
        path: raw.path,
        caption: raw.caption,
        dir: input.attachmentsDir ?? "",
      });
      attached++;
      emit({ type: "attachment.added", ...inTurn(), payload: { attachment } });
      return `Attached ${attachment.name}. It goes on your report.`;
    });
  };

  /** `expose`: the thread's live base now goes to this port, once something answers there (live.ts). */
  const expose = (raw: ExposeInput): Promise<ToolReply> =>
    toolCall(async () => {
      const preview = { port: checkPort(raw.port), path: livePath(raw.path) };
      const warning = await probeLive(input.threadId, preview);
      await checkListener(preview.port, input.cwd, listenerDirs);
      emit({ type: "preview.exposed", ...inTurn(), payload: preview });
      const url = `${liveBase(input.threadId)}${preview.path}`;
      return `Exposed: the card's "Open live" opens ${url} on Tenzo's live address, forwarded to localhost:${preview.port}. Keep the server running.${warning ? `\nWarning: ${warning}` : ""}`;
    });

  /** `wake_me`: the daemon keeps the time and sends the turn (engine.ts). */
  const wakeMe = async (raw: WakeInput): Promise<ToolReply> => {
    const ms = parseWait(raw.in);
    if (typeof ms === "string") return { text: ms, isError: true };
    const at = new Date(Date.now() + ms).toISOString();
    const why = raw.why.trim();
    emit({ type: "wake.scheduled", ...inTurn(), payload: { at, why } });
    return {
      text: `Tenzo wakes you at ${at} (in ${raw.in.trim()}) with "${wakePrompt(why)}". End your turn now; don't wait or poll meanwhile.`,
    };
  };

  /** `ready_to_merge`: after Open PR, a quick-lane card with Merge. Nothing waits for you. */
  const readyToMerge = async (raw: ReadyInput): Promise<ToolReply> => {
    if (phaseNow() !== "landing") {
      return {
        text: "Nothing to merge yet: ready_to_merge is for the PR you opened after the person chose Open PR.",
        isError: true,
      };
    }
    const url = WebUrl.safeParse(raw.url.trim());
    if (!url.success) return { text: "The PR's URL must be an http(s) link.", isError: true };
    const headline = raw.headline?.replaceAll(/\s+/g, " ").trim();
    emit({
      type: "merge.ready",
      requestId: randomId("req"),
      ...inTurn(),
      payload: { url: url.data, summary: raw.summary.trim(), ...(headline ? { headline } : {}) },
    });
    return {
      text: "The person has a card with Merge. End your turn now with one short line; their answer comes back to you as a message.",
    };
  };

  /** `landed`: the PR is merged; the daemon archives the thread once the turn ends. */
  const landed = (raw: LandedInput): Promise<ToolReply> =>
    toolCall(async () => {
      if (phaseNow() !== "landing") {
        throw new TenzoError(
          "Nothing has landed yet: call landed once the PR is merged, after the person chose Merge or Open PR.",
        );
      }
      const given = raw.url?.trim();
      const url = given ? WebUrl.safeParse(given) : undefined;
      if (url && !url.success) throw new TenzoError("The PR's URL must be an http(s) link.");
      if (await hasChanges(input.cwd)) {
        throw new TenzoError(
          "The worktree has uncommitted changes, and archiving removes it. Commit them or delete them, then call landed again.",
        );
      }
      const summary = raw.summary?.trim();
      emit({
        type: "thread.landed",
        ...inTurn(),
        payload: { ...(url ? { url: url.data } : {}), ...(summary ? { summary } : {}) },
      });
      return "Landed. Tenzo archives this thread when your turn ends: end it now with one line.";
    });

  /** `start_thread`: a new thread through the daemon's ordinary create, a few per session. */
  let started = 0;
  const startThread = (raw: StartThreadInput): Promise<ToolReply> =>
    toolCall(async () => {
      const daemon = input.host;
      if (!daemon) throw new TenzoError("This thread can't start threads.");
      if (started >= MAX_STARTED_THREADS) {
        throw new TenzoError(`A session starts at most ${MAX_STARTED_THREADS} threads.`);
      }
      const project = raw.project?.trim();
      const title = raw.title?.trim();
      const thread = await daemon.startThread({
        prompt: raw.prompt.trim(),
        ...(project ? { project } : {}),
        ...(title ? { title } : {}),
      });
      started++;
      return `Started ${thread.id} ("${thread.title}") in ${thread.projectName}, on ${thread.branch}. It talks to the person on its own; you won't hear from it.`;
    });

  const host: TenzoToolHost = {
    propose,
    report,
    attach,
    expose,
    wakeMe,
    readyToMerge,
    landed,
    startThread,
  };

  const canUseTool: CanUseTool = async (toolName, toolInput, context) => {
    // Tenzo's own tools are how the agent talks to Tenzo: nothing to ask the user about.
    if (isTenzoTool(toolName)) return { behavior: "allow", updatedInput: toolInput };
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
        input: boundedInput(toolInput), // Claude gets the full input back below
        itemId: context.toolUseID,
        // Over the full input: two requests alike in what was kept above must still differ.
        fingerprint: fingerprintOf(toolName, toolInput),
      },
    });
    const outcome = await waitFor(requestId, "request", context.signal);
    if (outcome.ended) return { behavior: "deny", message: "The session ended." };
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

  const append = input.prompts ? promptFor(input.prompts, input.phase) : "";
  const options: Options = {
    cwd: input.cwd,
    pathToClaudeCodeExecutable: claudePath,
    settingSources: [...SETTING_SOURCES],
    // Claude Code's own system prompt (without this the SDK would run with a minimal one), and
    // Tenzo's thread prompt after it.
    systemPrompt: { type: "preset", preset: "claude_code", ...(append ? { append } : {}) },
    // Added to the servers of the user's own config, which load as in a terminal.
    mcpServers: {
      [TENZO_MCP_SERVER]: tenzoMcpServer(host, { liveBase: liveBase(input.threadId) }),
    },
    // No permissionMode: the user's own defaultMode applies, in every phase.
    canUseTool,
    env: { ...claudeEnv(process.env), TENZO_LIVE_BASE: liveBase(input.threadId) },
    ...(resumed ? { resume: sessionId } : { sessionId }),
    ...(input.model ? { model: input.model } : {}),
  };

  const run = query({ prompt: prompts, options });

  /** Settles every open request: cancelled (an interrupt), or left unanswered (`ended`). */
  const cancelPending = (ended: boolean) => {
    for (const { kind, settle } of [...pending.values()]) settle(unanswered(kind, ended));
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
      cancelPending(true);
      events.close();
    }
  })();

  const answer = (requestId: RequestId, outcome: Settled): void => {
    const open = pending.get(requestId);
    if (!open || open.kind !== outcome.kind) {
      const what =
        outcome.kind === "request"
          ? "permission request"
          : outcome.kind === "proposal"
            ? "proposal"
            : "question";
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
      // A turn Claude started by itself doesn't block a prompt: startTurn closes it.
      if (state.turnId !== null && !state.synthetic) {
        throw new TenzoError("A turn is already running.");
      }
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
    respondToProposal(requestId, decision, note) {
      answer(requestId, { kind: "proposal", decision, ...(note ? { note } : {}) });
    },
    async interrupt() {
      cancelPending(false);
      await run.interrupt().catch(() => {}); // already finished: nothing to interrupt
    },
    async stop() {
      stopping = true;
      prompts.close(); // end of input: Claude finishes and exits
      cancelPending(true);
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

/** Runs a tool's work: a TenzoError is the agent's to read and fix, anything else is ours. */
async function toolCall(work: () => Promise<string>): Promise<ToolReply> {
  try {
    return { text: await work() };
  } catch (error) {
    if (error instanceof TenzoError) return { text: error.message, isError: true };
    return { text: `Tenzo couldn't do that: ${String(error)}`, isError: true };
  }
}

/**
 * Variables a running Claude Code session exports to its children. They describe that session
 * (its id, IDE connection, bridge wiring), not the user's configuration, so a daemon started from
 * inside Claude Code must not hand them to its threads.
 */
const PARENT_SESSION_VARS = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_ENTRYPOINT", // unset, the SDK stamps its own
  "CLAUDE_CODE_SSE_PORT", // the parent's IDE connection
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_PID",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_WORKER_EPOCH",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_ENVIRONMENT_KIND", // e.g. "bridge": adds hosted-only tools such as SendUserFile
  "CLAUDE_EFFORT", // the parent's live /effort; the user's own is effortLevel in settings
]);
const PARENT_SESSION_PREFIXES = ["CLAUDE_CODE_BRIDGE_"];

/**
 * The environment a thread's Claude runs with: ours, minus what belongs to a parent Claude Code
 * session. Everything that is the user's configuration stays: `CLAUDE_CONFIG_DIR`,
 * `ANTHROPIC_*`, Bedrock/Vertex switches, proxies, PATH, HOME, …
 */
export function claudeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || PARENT_SESSION_VARS.has(key)) continue;
    if (PARENT_SESSION_PREFIXES.some((prefix) => key.startsWith(prefix))) continue;
    out[key] = value;
  }
  return out;
}

const RECOMMENDED = /\s*\(recommended\)\s*/i;

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
      options: options.filter(isRecord).map((o) => {
        const raw = typeof o.label === "string" ? o.label : "";
        // Claude marks its suggestion in the label: "Blue (Recommended)". The card shows "Blue";
        // the answer must be the label exactly as Claude wrote it, so it matches the option.
        const label = raw.replace(RECOMMENDED, " ").trim();
        return {
          label,
          value: raw,
          description: typeof o.description === "string" ? o.description : "",
          recommended: label !== raw.trim(),
          ...(typeof o.preview === "string" && o.preview !== "" ? { preview: o.preview } : {}),
        };
      }),
      multiSelect: r.multiSelect === true,
    };
  });
}

/** Where Claude Code's installers put `claude`, for a daemon whose PATH lacks it (launchd). */
export const SYSTEM_CLAUDE_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/**
 * The user's own `claude`: `TENZO_CLAUDE_PATH` if set, else the first on PATH, else the usual
 * install locations (`~/.local/bin`, `~/.claude/local`, Homebrew, `/usr/local/bin`).
 */
export function findClaude(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  systemDirs: readonly string[] = SYSTEM_CLAUDE_DIRS,
): string {
  const override = env.TENZO_CLAUDE_PATH;
  if (override) {
    if (isExecutableFile(override)) return override;
    throw new TenzoError(`TENZO_CLAUDE_PATH is ${override}, which is not an executable file.`);
  }
  const dirs = [
    ...(env.PATH ?? "").split(delimiter).filter((dir) => dir !== ""),
    join(home, ".local", "bin"),
    join(home, ".claude", "local"),
    ...systemDirs,
  ];
  for (const dir of dirs) {
    const candidate = join(dir, "claude");
    if (isExecutableFile(candidate)) return candidate;
  }
  throw new TenzoError(
    "Can't find `claude` on PATH or where Claude Code installs it. Install it and sign in (`claude`), or set TENZO_CLAUDE_PATH.",
  );
}

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
