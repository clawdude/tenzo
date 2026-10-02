import type { RuntimeEvent, RuntimeEventOf } from "@tenzo/contracts";

/**
 * The parity check's verdicts, as pure functions over what a run left behind: the thread's
 * runtime events (`tenzo thread start --json`) and the hook's log in the worktree. `parity.ts`
 * does the running; everything here is unit-tested.
 */

/** What the fixture (`tools/parity/fixture`) defines. Change both together. */
export const FIXTURE = {
  agent: "parity-agent",
  // The codewords without the `KEY=` the fixture puts before them: Claude may drop it in a reply.
  agentCodeword: "lantern-42",
  skill: "parity-skill",
  skillCodeword: "compass-17",
  mcpServer: "parity",
  mcpTool: "mcp__parity__ping",
  /** Where the hook appends, relative to the worktree. */
  hookLog: ".parity/hooks.jsonl",
} as const;

/** The one prompt the thread gets. `word` is fresh per run, so the pong can't be guessed. */
export function parityPrompt(word: string): string {
  return [
    "This is Tenzo's feature-parity check. Do these four steps in order, each with the tool named, then stop. Don't read, write or run anything else.",
    `1. Run the skill ${FIXTURE.skill} with the Skill tool, and follow it.`,
    `2. Run the subagent ${FIXTURE.agent} with the Agent tool (subagent_type "${FIXTURE.agent}"), asking it for its codeword.`,
    `3. Call the MCP tool ${FIXTURE.mcpTool} with word "${word}".`,
    "4. Reply with one line: the skill's codeword, the subagent's codeword, and the ping's answer.",
  ].join("\n");
}

/** What the MCP tool answers to `word`. */
export function expectedPong(word: string): string {
  return `pong:${word}:tenzo-parity-mcp`;
}

export interface Check {
  name: string;
  pass: boolean;
  /** On a pass, the evidence; on a failure, the first thing that was missing. */
  detail: string;
}

export interface HookRecord {
  hook: string | null;
  tool: string | null;
}

/** The hook's log, one JSON object per line; unreadable lines are skipped. Null: no log at all. */
export function parseHookLog(text: string | null): HookRecord[] | null {
  if (text === null) return null;
  const records: HookRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (typeof value !== "object" || value === null) continue;
      const { hook, tool } = value as Record<string, unknown>;
      records.push({
        hook: typeof hook === "string" ? hook : null,
        tool: typeof tool === "string" ? tool : null,
      });
    } catch {
      // a torn line: skip it
    }
  }
  return records;
}

/** `tenzo thread start --json` output: one event per line. Lines that aren't JSON are skipped. */
export function parseEvents(stdout: string): RuntimeEvent[] {
  const events: RuntimeEvent[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      events.push(JSON.parse(line) as RuntimeEvent);
    } catch {
      // not an event
    }
  }
  return events;
}

/** One tool call, from its `item.started` (input) and `item.completed` (status, output). */
export interface ToolCall {
  itemId: string;
  toolName: string;
  toolKind: string;
  input: Record<string, unknown>;
  status: "in_progress" | "completed" | "failed";
  output: string;
  parentItemId?: string;
}

export function toolCalls(events: readonly RuntimeEvent[]): ToolCall[] {
  const calls = new Map<string, ToolCall>();
  for (const event of events) {
    if (event.type !== "item.started" && event.type !== "item.completed") continue;
    const p = event.payload;
    if (p.itemType !== "tool") continue;
    const known = calls.get(event.itemId);
    const input = isRecord(p.input) ? p.input : (known?.input ?? {});
    calls.set(event.itemId, {
      itemId: event.itemId,
      toolName: p.toolName ?? known?.toolName ?? "unknown",
      toolKind: p.toolKind ?? known?.toolKind ?? "tool",
      input,
      status: p.status,
      output: p.output ?? known?.output ?? "",
      ...(p.parentItemId ? { parentItemId: p.parentItemId } : {}),
    });
  }
  return [...calls.values()];
}

/** Everything the thread said: assistant messages and the turn's final result. */
function threadText(events: readonly RuntimeEvent[]): string {
  const parts: string[] = [];
  for (const event of events) {
    if (event.type === "item.completed" && event.payload.itemType === "assistant_message") {
      parts.push(event.payload.text ?? "");
    } else if (event.type === "turn.completed" && event.payload.result) {
      parts.push(event.payload.result);
    }
  }
  return parts.join("\n");
}

type Configured = RuntimeEventOf<"session.configured">["payload"];

/** The four parity checks, plus whether the turn itself ran clean, in table order. */
export function checkParity(
  events: readonly RuntimeEvent[],
  hooks: readonly HookRecord[] | null,
  word: string,
): Check[] {
  const configured = events.find(
    (e): e is RuntimeEventOf<"session.configured"> => e.type === "session.configured",
  )?.payload;
  const calls = toolCalls(events);
  return [
    checkSubagent(configured, calls, events),
    checkSkill(configured, calls, threadText(events)),
    checkHook(hooks),
    checkMcp(configured, calls, word),
    checkTurn(events),
  ];
}

function checkSubagent(
  configured: Configured | undefined,
  calls: ToolCall[],
  events: readonly RuntimeEvent[],
): Check {
  const name = "Subagent";
  if (!configured) return fail(name, "the session never reported its configuration");
  if (!configured.agents.includes(FIXTURE.agent)) {
    return fail(name, `${FIXTURE.agent} isn't loaded; agents: ${list(configured.agents)}`);
  }
  const subagentCalls = calls.filter((c) => c.toolKind === "subagent");
  const call = subagentCalls.find((c) => c.input.subagent_type === FIXTURE.agent);
  if (!call) {
    const seen = subagentCalls.map((c) => String(c.input.subagent_type ?? "?"));
    return fail(name, `Claude never ran ${FIXTURE.agent}; subagents run: ${list(seen)}`);
  }
  if (call.status !== "completed") return fail(name, `${call.toolName} ${call.status}${out(call)}`);
  // A foreground subagent's answer is the tool's result. A background one (Claude Code's default
  // for Agent now) returns "launched" at once; its answer is its own message, under the call.
  if (call.output.includes(FIXTURE.agentCodeword)) {
    return pass(name, `${call.toolName} → ${FIXTURE.agent} returned ${FIXTURE.agentCodeword}`);
  }
  const own = events.some(
    (e) =>
      e.type === "item.completed" &&
      e.payload.itemType === "assistant_message" &&
      e.payload.parentItemId === call.itemId &&
      (e.payload.text ?? "").includes(FIXTURE.agentCodeword),
  );
  if (own) {
    return pass(
      name,
      `${call.toolName} → ${FIXTURE.agent} (background) said ${FIXTURE.agentCodeword} in the thread`,
    );
  }
  return fail(name, `its answer never reached the thread${out(call)}`);
}

function checkSkill(configured: Configured | undefined, calls: ToolCall[], said: string): Check {
  const name = "Skill";
  if (!configured) return fail(name, "the session never reported its configuration");
  if (!configured.skills.includes(FIXTURE.skill)) {
    return fail(name, `${FIXTURE.skill} isn't listed; skills: ${list(configured.skills)}`);
  }
  const call = calls.find((c) => c.toolName === "Skill" && skillName(c.input) === FIXTURE.skill);
  if (!call) return fail(name, `listed, but Claude never invoked ${FIXTURE.skill}`);
  if (call.status !== "completed") return fail(name, `Skill ${call.status}${out(call)}`);
  if (!said.includes(FIXTURE.skillCodeword)) {
    return fail(
      name,
      `invoked, but its content never showed: no ${FIXTURE.skillCodeword} in the reply`,
    );
  }
  return pass(name, `listed, invoked by name, reply has ${FIXTURE.skillCodeword}`);
}

function checkHook(hooks: readonly HookRecord[] | null): Check {
  const name = "Hook";
  if (hooks === null) return fail(name, `no ${FIXTURE.hookLog} in the worktree: it never ran`);
  const post = hooks.filter((h) => h.hook === "PostToolUse");
  if (post.length === 0) return fail(name, `${FIXTURE.hookLog} has no PostToolUse entry`);
  const tools = [...new Set(post.map((h) => h.tool ?? "?"))];
  return pass(
    name,
    `PostToolUse ran ${post.length}× (${tools.join(", ")}), wrote ${FIXTURE.hookLog}`,
  );
}

function checkMcp(configured: Configured | undefined, calls: ToolCall[], word: string): Check {
  const name = "MCP server";
  if (!configured) return fail(name, "the session never reported its configuration");
  const server = configured.mcpServers.find((s) => s.name === FIXTURE.mcpServer);
  if (!server) {
    const names = configured.mcpServers.map((s) => s.name);
    return fail(name, `${FIXTURE.mcpServer} isn't loaded; servers: ${list(names)}`);
  }
  if (server.status !== "connected") return fail(name, `${FIXTURE.mcpServer} is ${server.status}`);
  const call = calls.find((c) => c.toolName === FIXTURE.mcpTool);
  if (!call) return fail(name, `connected, but Claude never called ${FIXTURE.mcpTool}`);
  if (call.status !== "completed")
    return fail(name, `${FIXTURE.mcpTool} ${call.status}${out(call)}`);
  const pong = expectedPong(word);
  if (!call.output.includes(pong)) return fail(name, `expected ${pong}${out(call)}`);
  return pass(name, `${FIXTURE.mcpServer} connected, ${FIXTURE.mcpTool} returned ${pong}`);
}

/**
 * What the run types at tenzo's prompts: `y` for the fixture's MCP tool (the only prompt a
 * fresh, untrusted copy of the fixture gets, exactly as in a terminal), a reason to deny
 * anything else, and end of input for a question. Undefined: the event asks nothing.
 */
export function answerFor(event: RuntimeEvent): string | null | undefined {
  if (event.type === "request.opened") {
    return event.payload.toolName === FIXTURE.mcpTool ? "y" : "Not part of the parity check.";
  }
  if (event.type === "user-input.requested") return null;
  return undefined;
}

function checkTurn(events: readonly RuntimeEvent[]): Check {
  const name = "Turn";
  const expected = events.filter((e) => e.type === "request.opened" && answerFor(e) === "y");
  const asked = events.flatMap((e) =>
    e.type === "request.opened" && answerFor(e) !== "y"
      ? [`permission for ${e.payload.detail}`]
      : e.type === "user-input.requested"
        ? [`an answer to: ${e.payload.questions.map((q) => q.question).join("; ")}`]
        : [],
  );
  const errors = events.flatMap((e) => (e.type === "runtime.error" ? [e.payload.message] : []));
  const done = events.find(
    (e): e is RuntimeEventOf<"turn.completed"> => e.type === "turn.completed",
  );
  if (asked.length > 0) return fail(name, `asked for ${asked.join(", ")}: not part of the check`);
  if (errors.length > 0) return fail(name, `error: ${errors.join("; ")}`);
  if (!done) return fail(name, "the turn never completed");
  const p = done.payload;
  if (p.state !== "completed")
    return fail(name, `${p.state}${p.errorMessage ? `: ${p.errorMessage}` : ""}`);
  const cost = p.costUsd === undefined ? "" : `, $${p.costUsd.toFixed(4)}`;
  const time = p.durationMs === undefined ? "" : `, ${(p.durationMs / 1000).toFixed(1)}s`;
  const model = events.find(
    (e): e is RuntimeEventOf<"session.configured"> => e.type === "session.configured",
  )?.payload.model;
  const allowed =
    expected.length === 0 ? "" : `, allowed ${FIXTURE.mcpTool} when asked (${expected.length}×)`;
  return pass(name, `completed${model ? ` on ${model}` : ""}${allowed}${cost}${time}`);
}

/** The PASS/FAIL table, then a verdict line. */
export function formatTable(checks: readonly Check[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  const rows = checks.map(
    (c) => `${c.name.padEnd(width)}  ${(c.pass ? "PASS" : "FAIL").padEnd(6)}  ${c.detail}`,
  );
  const failed = checks.filter((c) => !c.pass).length;
  const verdict =
    failed === 0
      ? "PASS: the thread had everything the terminal has."
      : `FAIL: ${failed} of ${checks.length} checks failed.`;
  return [`${"Check".padEnd(width)}  Result  Detail`, ...rows, "", verdict].join("\n");
}

function skillName(input: Record<string, unknown>): unknown {
  return input.skill ?? input.command ?? input.name;
}

function out(call: ToolCall): string {
  if (call.output === "") return "";
  const flat = call.output.replaceAll(/\s+/g, " ").trim();
  return `: "${flat.length > 160 ? `${flat.slice(0, 159)}…` : flat}"`;
}

function list(items: readonly string[]): string {
  return items.length === 0 ? "none" : items.join(", ");
}

function pass(name: string, detail: string): Check {
  return { name, pass: true, detail };
}

function fail(name: string, detail: string): Check {
  return { name, pass: false, detail };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
