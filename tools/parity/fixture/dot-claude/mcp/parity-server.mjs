#!/usr/bin/env node
// The parity check's MCP server: one tool, `ping`, that answers `pong:<word>:tenzo-parity-mcp`.
// MCP over stdio is newline-delimited JSON-RPC 2.0, so plain Node is enough: no SDK, no install.
import { createInterface } from "node:readline";

const PING = {
  name: "ping",
  description: "Tenzo parity check: answers pong with the word you send.",
  inputSchema: {
    type: "object",
    properties: { word: { type: "string", description: "Any word; it comes back in the pong." } },
    required: ["word"],
  },
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.id === undefined || message.id === null) return; // a notification: nothing to say
  const result = (value) => send({ jsonrpc: "2.0", id: message.id, result: value });
  const error = (code, text) =>
    send({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });

  switch (message.method) {
    case "initialize":
      return result({
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "parity", version: "1.0.0" },
      });
    case "ping":
      return result({});
    case "tools/list":
      return result({ tools: [PING] });
    case "tools/call": {
      if (message.params?.name !== PING.name) {
        return error(-32602, `Unknown tool: ${message.params?.name}`);
      }
      const word = String(message.params?.arguments?.word ?? "");
      return result({ content: [{ type: "text", text: `pong:${word}:tenzo-parity-mcp` }] });
    }
    default:
      return error(-32601, `Method not found: ${message.method}`);
  }
});
