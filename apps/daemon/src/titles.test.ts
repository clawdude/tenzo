import type { Options, Query, query as sdkQuery, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { cleanTitle, createClaudeTitler, quickTitle } from "./titles.ts";

describe("quickTitle", () => {
  it("keeps a short first line whole", () => {
    expect(quickTitle("  Fix the login bug\nDetails follow")).toBe("Fix the login bug");
    expect(quickTitle("Dark mode.")).toBe("Dark mode");
  });

  it("cuts after four words, at a word, and says it cut", () => {
    expect(quickTitle("Rate-limit the public API: 100 requests a minute per key")).toBe(
      "Rate-limit the public API…",
    );
    expect(quickTitle("Ask me with AskUserQuestion whether to greet")).toBe(
      "Ask me with AskUserQuestion…",
    );
  });

  it("stops early on long words, and cuts a single huge one", () => {
    expect(quickTitle("Investigate intermittently-failing authentication middleware tests")).toBe(
      "Investigate intermittently-failing…",
    );
    expect(quickTitle(`https://example.com/${"a".repeat(80)}`)).toHaveLength(37);
  });

  it("is empty for an empty prompt", () => {
    expect(quickTitle("   \n  ")).toBe("");
  });
});

describe("cleanTitle", () => {
  it("takes a plain answer as it is", () => {
    expect(cleanTitle("Greeting language")).toBe("Greeting language");
    expect(cleanTitle("refresh tokens")).toBe("Refresh tokens");
  });

  it("strips quotes, labels, markdown and a full stop", () => {
    expect(cleanTitle('"Rate limit the API."')).toBe("Rate limit the API");
    expect(cleanTitle("Title: Fix flaky checkout test")).toBe("Fix flaky checkout test");
    expect(cleanTitle("**Dark mode**\n")).toBe("Dark mode");
    expect(cleanTitle("\n\n“Hero redesign”")).toBe("Hero redesign");
  });

  it("refuses an answer that isn't a name", () => {
    expect(cleanTitle("")).toBeNull();
    expect(cleanTitle("I'll start by reading the repository to see what needs doing")).toBeNull();
    expect(cleanTitle("x".repeat(60))).toBeNull();
  });
});

describe("createClaudeTitler", () => {
  function fakeQuery(messages: () => AsyncIterable<SDKMessage>) {
    const calls: { prompt: unknown; options: Options | undefined }[] = [];
    const query = ((params: { prompt: unknown; options?: Options }) => {
      calls.push({ prompt: params.prompt, options: params.options });
      return messages() as Query;
    }) as typeof sdkQuery;
    return { query, calls };
  }
  const result = (text: string, subtype = "success") =>
    ({ type: "result", subtype, result: text }) as unknown as SDKMessage;

  it("asks the cheapest model, with nothing of the user's loaded, and cleans its answer", async () => {
    const { query, calls } = fakeQuery(async function* () {
      yield { type: "system", subtype: "init" } as unknown as SDKMessage;
      yield result('"Greeting language."');
    });
    const titler = createClaudeTitler({ query, claudePath: "/opt/bin/claude" });
    const title = await titler("Ask me how to greet", new AbortController().signal);
    expect(title).toBe("Greeting language");
    const [call] = calls;
    expect(String(call?.prompt)).toContain("Ask me how to greet");
    expect(call?.options).toMatchObject({
      pathToClaudeCodeExecutable: "/opt/bin/claude",
      model: "haiku",
      tools: [],
      settingSources: [],
      mcpServers: {},
      strictMcpConfig: true,
      persistSession: false,
      maxTurns: 1,
    });
  });

  it("gives null for a failed run, an unusable answer, or an error", async () => {
    const signal = new AbortController().signal;
    const failed = fakeQuery(async function* () {
      yield result("", "error_during_execution");
    });
    expect(await createClaudeTitler({ ...failed, claudePath: "c" })("x", signal)).toBeNull();
    const chatty = fakeQuery(async function* () {
      yield result("Sure! Here is a title you could use for this task: Greeting");
    });
    expect(await createClaudeTitler({ ...chatty, claudePath: "c" })("x", signal)).toBeNull();
    const broken = fakeQuery(async function* () {
      yield* [];
      throw new Error("Claude Code process exited with code 1");
    });
    expect(await createClaudeTitler({ ...broken, claudePath: "c" })("x", signal)).toBeNull();
  });

  it("passes an abort on to the run", async () => {
    const stop = new AbortController();
    let seen: AbortController | undefined;
    const { query } = fakeQuery(async function* () {
      yield* [];
      if (!seen?.signal.aborted) {
        await new Promise((resolve) => seen?.signal.addEventListener("abort", resolve));
      }
      throw new Error("aborted");
    });
    const titler = createClaudeTitler({
      query: ((params: { prompt: unknown; options?: Options }) => {
        seen = params.options?.abortController;
        return query(params as Parameters<typeof sdkQuery>[0]);
      }) as typeof sdkQuery,
      claudePath: "c",
    });
    const naming = titler("x", stop.signal);
    stop.abort();
    expect(await naming).toBeNull();
    expect(seen?.signal.aborted).toBe(true);
  });
});
