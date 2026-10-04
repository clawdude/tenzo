import type { QueueItem, RuntimeEvent } from "@tenzo/contracts";

/** How the CLI shows threads' events and items. */

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
  } else if (item.kind === "proposal") {
    lines.push(`  ! ${item.ask}`);
    for (const line of (item.proposal?.summary ?? "").split("\n")) {
      if (line.trim() !== "") lines.push(`    ${line.trimEnd()}`);
    }
    lines.push("    1. Build it (suggested)", "    Or say what to change.");
  } else {
    lines.push(`  ? ${item.ask}`);
    if (item.permission?.reason) lines.push(`    (${item.permission.reason})`);
    lines.push("    1. Allow (suggested)", "    2. Deny");
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
    case "proposal.requested":
      return event.payload.headline;
    case "proposal.resolved":
      return event.payload.decision + (event.payload.note ? `: ${event.payload.note}` : "");
    case "runtime.error":
      return event.payload.message;
    case "thread.archived":
      return "worktree removed, open items dismissed";
  }
}

function quote(text: string): string {
  return `"${oneLine(text, 120)}"`;
}

function oneLine(text: string, limit: number): string {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
