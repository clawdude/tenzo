import type { QueueItem, RuntimeEvent, ThreadView } from "@tenzo/contracts";

/** How the CLI shows threads' events and items. */

/** A thread as a row of `tenzo thread list`: id, project, state, phase, branch, title. */
export function threadRow(t: ThreadView): string[] {
  // An archived thread's last phase says nothing more; whether it landed does.
  const state = t.status === "archived" ? [t.landed ? "archived · landed" : "archived", ""] : [t.activity, t.phase];
  const title = t.origin === "automation" ? `${t.title} (automation: ${t.automation ?? "?"})` : t.title;
  return [t.id, t.projectName, ...state, t.branch, title];
}

/** An open item as a few lines: who asks, the context, the ask, numbered options. */
export function formatItem(item: QueueItem, threadTitle?: string): string {
  const head = [item.id, threadTitle, item.kind].filter(Boolean).join(" · ");
  const lines = [head];
  if (item.context) lines.push(`  ${oneLine(item.context, 300)}`);
  const questions = item.kind === "question" && item.questions.length > 0 ? item.questions : null;
  if (questions) {
    for (const q of questions) {
      lines.push(`  ? ${q.question}${q.header ? `  [${q.header}]` : ""}`);
      q.options.forEach((o, i) => {
        const suggested = o.recommended ? " (suggested)" : "";
        const description = o.description ? ` — ${o.description}` : "";
        lines.push(`    ${i + 1}. ${o.label}${suggested}${description}`);
      });
    }
  } else if (item.kind === "error") {
    lines.push(`  ! ${item.ask}`);
    if (item.error?.message) lines.push(`    ${oneLine(item.error.message, 300)}`);
    if (item.error?.cause === "budget") {
      lines.push("    1. Continue (suggested): as much budget again", "    2. Stop: archive the thread", "    Or tell it what to do.");
    } else {
      lines.push("    1. Retry (suggested)", "    2. Archive", "    Or tell it something.");
    }
  } else if (item.kind === "proposal") {
    lines.push(`  ! ${item.ask}`);
    for (const line of (item.proposal?.summary ?? "").split("\n")) {
      if (line.trim() !== "") lines.push(`    ${line.trimEnd()}`);
    }
    lines.push("    1. Build it (suggested)", "    Or say what to change.");
  } else if (item.kind === "finished" && item.finished) {
    lines.push(`  ✓ ${item.ask}`);
    const f = item.finished;
    for (const line of f.summary.split("\n")) {
      if (line.trim() !== "") lines.push(`    ${line.trimEnd()}`);
    }
    if (f.checks.length > 0) {
      lines.push(`    Checks: ${f.checks.map((c) => `${c.name} ${c.status}`).join(", ")}`);
    }
    if (f.attachments.length > 0) lines.push(`    Screenshots: ${f.attachments.length}`);
    if (f.live) lines.push(`    Live: port ${f.live.port}`);
    // Words, not numbers: landing is never one keystroke away.
    lines.push(
      "    merge: open the PR, see it through, merge it",
      "    pr: open the PR, ask me before merging",
      "    done: nothing to land",
      "    Or say what needs changing.",
    );
  } else if (item.kind === "ready" && item.ready) {
    lines.push(`  ✓ ${item.ask}`, `    ${item.ready.url}`);
    for (const line of item.ready.summary.split("\n")) {
      if (line.trim() !== "") lines.push(`    ${line.trimEnd()}`);
    }
    lines.push("    merge: merge it now", "    Or say what to do first.");
  } else {
    lines.push(`  ? ${item.ask}`);
    if (item.permission?.reason) lines.push(`    (${item.permission.reason})`);
    lines.push("    1. Allow (suggested)", "    2. Deny");
  }
  if (item.snoozedUntil) {
    lines.push(`  Snoozed until ${new Date(item.snoozedUntil).toLocaleTimeString()}.`);
  }
  if (item.detached) {
    lines.push("  The agent that asked has stopped; answering resumes it with your answer.");
  }
  return lines.join("\n");
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
        costOf(p.turnCostUsd, p.costUsd),
        timeOf(p.durationMs, p.waitedMs),
        p.errorMessage,
        p.stoppedBy === "budget" ? "stopped at its spend limit" : undefined,
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
    case "proposal.requested":
      return event.payload.headline;
    case "proposal.resolved":
      return event.payload.decision + (event.payload.note ? `: ${event.payload.note}` : "");
    case "attachment.added": {
      const a = event.payload.attachment;
      return `${a.name}${a.caption ? ` (${a.caption})` : ""}`;
    }
    case "preview.exposed":
      return `port ${event.payload.port}${event.payload.path ? ` /${event.payload.path}` : ""}`;
    case "report.submitted":
      return [
        event.payload.headline ?? oneLine(event.payload.summary, 80),
        ...event.payload.checks.map((c) => `${c.name} ${c.status}`),
      ].join(" · ");
    case "report.resolved":
    case "merge.resolved":
      return event.payload.decision + (event.payload.note ? `: ${event.payload.note}` : "");
    case "merge.ready":
      return `${event.payload.headline ?? oneLine(event.payload.summary, 80)} · ${event.payload.url}`;
    case "wake.scheduled":
      return `at ${event.payload.at}: ${event.payload.why}`;
    case "wake.fired":
      return event.payload.why;
    case "thread.landed":
      return [event.payload.url, event.payload.summary].filter(Boolean).join(" · ");
    case "landing.stuck":
      return `${event.payload.cause}: ${event.payload.message}`;
    case "budget.exceeded":
      return event.payload.message;
    case "runtime.error":
    case "thread.noted":
      return event.payload.message;
    case "config.checked":
      return event.payload.problem ?? "fine again";
    case "thread.archived":
      return "worktree removed, open items dismissed";
    case "item.snoozed":
      return `until ${event.payload.until}`;
    case "item.unsnoozed":
      return event.payload.reason;
    case "error.resolved":
      return event.payload.action + (event.payload.text ? `: ${quote(event.payload.text)}` : "");
  }
}

/** The turn's own cost, and the session's running total, labelled as such. */
function costOf(turn: number | undefined, session: number | undefined): string | undefined {
  if (session === undefined) return undefined;
  const total = `$${session.toFixed(4)} session total`;
  return turn === undefined ? total : `$${turn.toFixed(4)} this turn (${total})`;
}

/** How long the turn took: working, and waiting on you, when the daemon measured that. */
function timeOf(durationMs: number | undefined, waitedMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  const seconds = (ms: number) => `${(ms / 1000).toFixed(1)}s`;
  if (waitedMs === undefined) return `${seconds(durationMs)} wall clock`;
  const working = `${seconds(Math.max(0, durationMs - waitedMs))} working`;
  return waitedMs > 0 ? `${working}, ${seconds(waitedMs)} waiting on you` : working;
}

function quote(text: string): string {
  return `"${oneLine(text, 120)}"`;
}

function oneLine(text: string, limit: number): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
