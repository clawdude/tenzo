import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, chromium, devices, type Page } from "playwright-core";

/**
 * `pnpm smoke`: the web app in a real browser against a scratch daemon, for what unit tests
 * can't see: SvelteKit's router starting, screens sharing one connection, the history. It loads
 * each screen directly (a reload, a bookmark) and walks New → Close → New → Close → Threads → ×,
 * then checks there were no page errors, one WebSocket, one page load, and the draft survived.
 *
 * It needs a Chromium: TENZO_SMOKE_CHROMIUM, else the one Playwright caches. No agent runs, so
 * no `claude` is needed. It never touches ~/.tenzo or the default port.
 */

const REPO_ROOT = resolve(import.meta.dirname, "../../..");
const CLI = join(REPO_ROOT, "apps/daemon/src/cli.ts");
const WEB_DIR = join(REPO_ROOT, "apps/web/build");

function findChromium(): string | undefined {
  if (process.env.TENZO_SMOKE_CHROMIUM) return process.env.TENZO_SMOKE_CHROMIUM;
  const caches = [
    join(homedir(), "Library/Caches/ms-playwright"),
    join(homedir(), ".cache/ms-playwright"),
  ];
  const inside = [
    "chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    "chrome-linux64/chrome",
    "chrome-linux/chrome",
  ];
  for (const cache of caches) {
    if (!existsSync(cache)) continue;
    const builds = readdirSync(cache)
      .filter((d) => /^chromium-\d+$/.test(d))
      .sort()
      .reverse();
    for (const build of builds) {
      for (const path of inside) {
        const candidate = join(cache, build, path);
        if (existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined; // Playwright's own lookup, which names what is missing
}

function freePort(): Promise<number> {
  return new Promise((done, failed) => {
    const server = createServer();
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => done(port));
    });
  });
}

/**
 * A scratch repo with one commit; git without the developer's config. Its config defines one
 * automation, scheduled a day away: the list has something to show, and nothing runs.
 */
function scratchRepo(dir: string): string {
  const repo = join(dir, "app");
  mkdirSync(join(repo, ".tenzo"), { recursive: true });
  writeFileSync(join(repo, "README.md"), "# app\n");
  writeFileSync(
    join(repo, ".tenzo/config.json"),
    JSON.stringify({ automations: { nightly: { prompt: "Check the dependencies.", trigger: { schedule: "every 1d" } } } }),
  );
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Tenzo Smoke",
    GIT_AUTHOR_EMAIL: "smoke@tenzo.invalid",
    GIT_COMMITTER_NAME: "Tenzo Smoke",
    GIT_COMMITTER_EMAIL: "smoke@tenzo.invalid",
  };
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-qm", "init"]]) {
    execFileSync("git", args, { cwd: repo, env });
  }
  return repo;
}

async function startDaemon(env: NodeJS.ProcessEnv, port: number) {
  const log: string[] = [];
  const child = spawn(process.execPath, [CLI, "serve"], {
    cwd: REPO_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding("utf8").on("data", (chunk: string) => log.push(chunk));
  }
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill("SIGTERM");
    await exited;
  };
  const deadline = Date.now() + 15_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`tenzo serve exited:\n${log.join("")}`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return { stop };
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error(`tenzo serve didn't come up on port ${port}:\n${log.join("")}`);
    }
    await sleep(100);
  }
}

interface Watch {
  errors: string[];
  sockets: number;
  documents: number;
}

/** What the browser says when an animation is handed a bad keyframe (a NaN offset, say). */
const BAD_KEYFRAME = /invalid keyframe|NaN(px|deg)/i;

function watch(page: Page): Watch {
  const seen: Watch = { errors: [], sockets: 0, documents: 0 };
  page.on("pageerror", (error) => seen.errors.push(error.message));
  page.on("console", (message) => {
    if (BAD_KEYFRAME.test(message.text())) seen.errors.push(`console: ${message.text()}`);
  });
  page.on("websocket", () => seen.sockets++);
  page.on("request", (request) => {
    if (request.resourceType() === "document") seen.documents++;
  });
  return seen;
}

const path = (page: Page) => new URL(page.url()).pathname;

/** From the Pass: New, type, Close, New (the draft is still there), Close, Threads, ×. */
async function walk(page: Page): Promise<string> {
  await page.getByTestId("new").first().tap();
  await page.getByTestId("new-thread").waitFor();
  await page.getByTestId("prompt").fill("A draft that must survive Close");
  await page.getByTestId("close").tap();
  await page.getByTestId("pass").waitFor();
  await page.getByTestId("new").first().tap();
  await page.getByTestId("new-thread").waitFor();
  const draft = await page.getByTestId("prompt").inputValue();
  await page.getByTestId("close").tap();
  await page.getByTestId("pass").waitFor();
  await page.getByTestId("threads").tap();
  await page.getByTestId("threads-list").waitFor();
  await page.getByTestId("to-pass").tap();
  await page.getByTestId("pass").waitFor();
  return draft;
}

/** Loads `start` directly, gets to the Pass the way a person would, then walks. */
async function run(browser: Browser, base: string, start: string): Promise<string[]> {
  const context = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await context.newPage();
  const seen = watch(page);
  const problems: string[] = [];
  try {
    await page.goto(base + start);
    if (start === "/new") {
      await page.getByTestId("new-thread").waitFor();
      await page.getByTestId("close").tap();
    } else if (start === "/threads") {
      await page.getByTestId("threads-list").waitFor();
      await page.getByTestId("to-pass").tap();
    }
    await page.getByTestId("pass").waitFor();
    if (path(page) !== "/") problems.push(`landed on ${path(page)}, not the Pass`);
    const draft = await walk(page);
    if (draft !== "A draft that must survive Close") problems.push(`the draft was "${draft}"`);
    if (path(page) !== "/") problems.push(`ended on ${path(page)}, not the Pass`);
    // History: back from the Pass leaves the app's screens behind, not a pile of them.
    const length = await page.evaluate(
      () => (globalThis as unknown as { history: { length: number } }).history.length,
    );
    if (length > 4) problems.push(`${length} history entries`);
  } catch (error) {
    problems.push(String(error));
  } finally {
    await context.close();
  }
  if (seen.errors.length > 0) problems.push(`page errors: ${seen.errors.join("; ")}`);
  if (seen.sockets !== 1) problems.push(`${seen.sockets} WebSockets, not 1`);
  if (seen.documents !== 1) problems.push(`${seen.documents} page loads, not 1`);
  return problems;
}

/**
 * From an outside page: the Pass, New, reload, Close. Close must go back to the Pass the tab
 * already has (the trail outlives the reload), so one more back leaves the app.
 */
async function reload(browser: Browser, base: string): Promise<string[]> {
  const context = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await context.newPage();
  const seen = watch(page);
  const problems: string[] = [];
  try {
    await page.goto("data:text/html,<title>outside</title>");
    await page.goto(`${base}/`);
    await page.getByTestId("new").first().tap();
    await page.getByTestId("new-thread").waitFor();
    await page.reload();
    await page.getByTestId("new-thread").waitFor();
    await page.getByTestId("close").tap();
    await page.getByTestId("pass").waitFor();
    if (path(page) !== "/") problems.push(`Close landed on ${path(page)}, not the Pass`);
    await page.goBack();
    if (!page.url().startsWith("data:")) {
      problems.push(`back from the Pass went to ${page.url()}, not out of the app`);
    }
  } catch (error) {
    problems.push(String(error));
  } finally {
    await context.close();
  }
  if (seen.errors.length > 0) problems.push(`page errors: ${seen.errors.join("; ")}`);
  return problems;
}

/**
 * A thread's timeline: from a row of the Threads list and back, or loaded directly (a bookmark),
 * when Back goes to the Pass. The thread has no agent, so its timeline is empty but live.
 */
async function thread(browser: Browser, base: string, id: string, direct: boolean): Promise<string[]> {
  const context = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await context.newPage();
  const seen = watch(page);
  const problems: string[] = [];
  try {
    if (direct) {
      await page.goto(`${base}/threads/${id}`);
    } else {
      await page.goto(`${base}/threads`);
      await page.locator(`[data-testid="thread-row"][data-id="${id}"] a`).tap();
    }
    await page.getByTestId("thread-view").waitFor();
    if (path(page) !== `/threads/${id}`) problems.push(`opened ${path(page)}`);
    await page.locator('[data-testid="timeline"][data-status="live"]').waitFor();
    const title = await page.getByTestId("thread-title").textContent();
    if (title?.trim() !== "Smoke thread") problems.push(`the title was "${title}"`);
    // Nothing open, nothing running: it takes a message.
    const hint = await page.getByTestId("message").getAttribute("placeholder");
    if (hint !== "Message…") problems.push(`the message field's hint was "${hint}"`);
    await page.getByTestId("back").tap();
    await page.getByTestId(direct ? "pass" : "threads-list").waitFor();
  } catch (error) {
    problems.push(String(error));
  } finally {
    await context.close();
  }
  if (seen.errors.length > 0) problems.push(`page errors: ${seen.errors.join("; ")}`);
  if (seen.sockets !== 1) problems.push(`${seen.sockets} WebSockets, not 1`);
  if (seen.documents !== 1) problems.push(`${seen.documents} page loads, not 1`);
  return problems;
}

/**
 * The Automations list: loaded directly (Close goes to the Pass), or from Threads (Close goes
 * back there). It shows the scratch repo's automation with its next run, and the off switch
 * flips both ways, live.
 */
async function automations(browser: Browser, base: string, direct: boolean): Promise<string[]> {
  const context = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await context.newPage();
  const seen = watch(page);
  const problems: string[] = [];
  try {
    if (direct) {
      await page.goto(`${base}/automations`);
    } else {
      await page.goto(`${base}/threads`);
      await page.getByTestId("to-automations").tap();
    }
    await page.getByTestId("automations-list").waitFor();
    if (path(page) !== "/automations") problems.push(`opened ${path(page)}`);
    const row = page.locator('[data-testid="automation"][data-name="nightly"]');
    await row.waitFor();
    const next = (await row.getByTestId("next").textContent())?.trim();
    if (next !== "in 1d") problems.push(`its next run read "${next}"`);
    const schedule = (await row.getByTestId("schedule").textContent())?.trim();
    if (schedule !== "every day") problems.push(`its schedule read "${schedule}"`);
    if (direct) {
      await page.getByTestId("pause").tap();
      await page.locator('[data-testid="pause"][data-paused="true"]').waitFor();
      await row.locator('[data-testid="next"]', { hasText: "paused" }).waitFor();
      await page.getByTestId("pause").tap();
      await page.locator('[data-testid="pause"][data-paused="false"]').waitFor();
    }
    await page.getByTestId("close").tap();
    await page.getByTestId(direct ? "pass" : "threads-list").waitFor();
  } catch (error) {
    problems.push(String(error));
  } finally {
    await context.close();
  }
  if (seen.errors.length > 0) problems.push(`page errors: ${seen.errors.join("; ")}`);
  if (seen.sockets !== 1) problems.push(`${seen.sockets} WebSockets, not 1`);
  if (seen.documents !== 1) problems.push(`${seen.documents} page loads, not 1`);
  return problems;
}

/**
 * A long, busy thread, read further up: the feed is full (2000 events) and new ones keep coming,
 * so the oldest drop off. Whatever row you're reading must not move. The daemon is played by a
 * routed WebSocket, which streams the events; scroll anchoring is off on the timeline (as on iOS
 * Safari, which has none), so only the app can hold the place.
 */
async function heldPlace(browser: Browser, base: string): Promise<string[]> {
  const context = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await context.newPage();
  const seen = watch(page);
  const problems: string[] = [];
  const environmentId = "env_smoke000000000000000";
  const threadId = "thr_smoketimeline0000000".slice(0, 24);
  const at = new Date().toISOString();
  const event = (seq: number) => ({
    seq,
    environmentId,
    event: {
      type: "item.completed",
      eventId: `evt_${String(seq).padStart(20, "0")}`,
      threadId,
      agent: "claude",
      createdAt: at,
      itemId: `m${seq}`,
      payload: { itemType: "assistant_message", status: "completed", text: `Line ${seq} of a long thread.` },
    },
  });
  const thread = fakeThread(environmentId, threadId, at);
  let next = 2001;
  let stream: ((count: number) => void) | null = null;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    const send = (frame: unknown) => ws.send(JSON.stringify(frame));
    send({ type: "hello", environmentId, version: "smoke", serverTime: at });
    send({
      type: "snapshot",
      snapshot: { environmentId, threads: [thread], items: [], projects: [], live: null },
    });
    ws.onMessage((data) => {
      const frame = JSON.parse(String(data)) as { type: string; id?: string; command?: { type: string } };
      if (frame.type === "ping") send({ type: "pong", at });
      if (frame.type !== "command" || !frame.command) return;
      const result =
        frame.command.type === "thread.watch"
          ? {
              thread,
              events: Array.from({ length: 2000 }, (_, i) => event(i + 1)),
              older: true,
              reset: true,
            }
          : { watching: false };
      send({ type: "ok", id: frame.id, result });
    });
    stream = (count) => {
      for (let i = 0; i < count; i++) send({ type: "event", event: event(next++) });
    };
  });
  try {
    await page.goto(`${base}/threads/${threadId}`);
    const timeline = page.locator('[data-testid="timeline"][data-status="live"]');
    await timeline.waitFor();
    // At the end first: the timeline scrolls itself down to the latest row.
    await page.locator('[data-key="said:m2000"]').waitFor();
    for (let i = 0; i < 50 && (await timeline.evaluate((el) => el.scrollTop)) === 0; i++) {
      await sleep(50);
    }
    // Read further up: well away from the end.
    await timeline.evaluate((el) => (el.scrollTop = el.scrollTop - 900));
    await page.locator('[data-testid="timeline"][data-following="false"]').waitFor();
    const key = await page.locator('[data-testid="row"]').nth(20).getAttribute("data-key");
    const top = async () => (await page.locator(`[data-key="${key}"]`).boundingBox())?.y ?? null;
    const before = await top();
    for (let round = 0; round < 10; round++) {
      (stream as ((count: number) => void) | null)?.(30);
      await sleep(50);
    }
    await page.locator('[data-testid="timeline"][data-newer="300"]').waitFor();
    const after = await top();
    if (before === null || after === null || Math.abs(after - before) > 1) {
      problems.push(`the row being read moved from ${before} to ${after}`);
    }
    await page.getByTestId("newer").tap();
    await page.locator('[data-key="said:m2300"]').waitFor();
  } catch (error) {
    problems.push(String(error));
  } finally {
    await context.close();
  }
  if (seen.errors.length > 0) problems.push(`page errors: ${seen.errors.join("; ")}`);
  return problems;
}

/** A thread as the daemon sends it, for checks that play the daemon over a stubbed WebSocket. */
function fakeThread(environmentId: string, threadId: string, at: string) {
  return {
      id: threadId,
      environmentId,
      projectId: "prj_smoke000000000000000",
      projectName: "app",
      title: "Busy thread",
      branch: "tenzo/busy",
      worktreePath: "/tmp/busy",
      status: "active",
      agent: "claude",
      model: null,
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      phase: "building",
      activity: "working",
      working: true,
      queued: 0,
      openItems: 0,
      lastSeq: 2000,
      activeAt: at,
  };
}

/**
 * The Pass's motion (PRODUCT.md §5): the first card arrives, an answer lifts it away, a swipe
 * flings the next one aside to snooze it, and Undo brings it back in from that side; with motion,
 * or with reduced motion (cards change in place). No animation may be handed a bad keyframe
 * (a NaN offset logs "Invalid keyframe"; see `watch`). The daemon is played by a routed
 * WebSocket, so there are items to answer without an agent.
 */
async function passMotion(browser: Browser, base: string, reduced: boolean): Promise<string[]> {
  const context = await browser.newContext({
    ...devices["iPhone 15"],
    reducedMotion: reduced ? "reduce" : "no-preference",
  });
  const page = await context.newPage();
  const seen = watch(page);
  const problems: string[] = [];
  const environmentId = "env_smoke000000000000000";
  const threadId = "thr_smokepass00000000000";
  const at = new Date().toISOString();
  const thread = {
    id: threadId,
    environmentId,
    projectId: "prj_smoke000000000000000",
    projectName: "app",
    title: "Pass thread",
    branch: "tenzo/pass",
    worktreePath: "/tmp/pass",
    status: "active",
    agent: "claude",
    model: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    phase: "discussing",
    activity: "needs-you",
    working: false,
    queued: 0,
    openItems: 2,
    lastSeq: 0,
    activeAt: at,
  };
  const options = [
    { label: "Yes", value: "Yes", description: "Go on", recommended: true },
    { label: "No", value: "No", description: "Stop", recommended: false },
  ];
  const item = (tag: string, ask: string) => ({
    id: `itm_${tag.repeat(20)}`,
    environmentId,
    threadId,
    lane: "quick",
    kind: "question",
    requestId: `req_${tag.repeat(20)}`,
    context: "",
    ask,
    options,
    suggested: "Yes",
    questions: [{ id: ask, header: "", question: ask, options, multiSelect: false }],
    createdAt: at,
    status: "open",
    detached: false,
    resolvedAt: null,
    resolution: null,
    snoozedUntil: null,
  });
  const first = item("a", "First question?");
  const second = item("b", "Second question?");
  let send: (frame: unknown) => void = () => {};
  await page.routeWebSocket(/\/ws$/, (ws) => {
    send = (frame) => ws.send(JSON.stringify(frame));
    send({ type: "hello", environmentId, version: "smoke", serverTime: at });
    send({
      type: "snapshot",
      snapshot: { environmentId, threads: [thread], items: [], projects: [], live: null },
    });
    ws.onMessage((data) => {
      const frame = JSON.parse(String(data)) as {
        type: string;
        id?: string;
        command?: { type: string; itemId?: string };
      };
      if (frame.type === "ping") send({ type: "pong", at });
      if (frame.type !== "command" || !frame.command) return;
      const which = frame.command.itemId === first.id ? first : second;
      // As the daemon does: the item's frame, then the command's answer.
      const answer = (change: string, changed: object, result: object) => {
        send({ type: "item", change, item: changed });
        send({ type: "ok", id: frame.id, result: { item: changed, thread, ...result } });
      };
      switch (frame.command.type) {
        case "item.answer":
          return answer(
            "resolved",
            {
              ...which,
              status: "resolved",
              resolvedAt: new Date().toISOString(),
              resolution: { kind: "answered", answers: { [which.ask]: "Yes" } },
            },
            { delivery: "live" },
          );
        case "item.snooze":
          return answer(
            "snoozed",
            { ...which, snoozedUntil: new Date(Date.now() + 15 * 60_000).toISOString() },
            {},
          );
        case "item.unsnooze":
          return answer("unsnoozed", which, {});
        default:
          send({ type: "error", id: frame.id ?? null, error: `no ${frame.command.type} here` });
      }
    });
  });
  const top = (ask: string) => page.getByTestId("top").filter({ hasText: ask });
  /** Long enough for any arrive or leave animation to have run its course. */
  const settle = () => sleep(600);
  try {
    await page.goto(`${base}/`);
    await page.locator('[data-testid="connection"][data-synced="true"]').waitFor({ state: "attached" });
    // The first card arrives on an empty Pass; the second goes behind it.
    send({ type: "item", change: "opened", item: first });
    send({ type: "item", change: "opened", item: second });
    await top("First question?").waitFor();
    const moving = await page.evaluate(
      () =>
        (globalThis as unknown as { document: { getAnimations(): unknown[] } }).document.getAnimations()
          .length,
    );
    if (!reduced && moving === 0) problems.push("the first card arrived without moving");
    await settle();
    // Answer: it lifts away, and the second card is there.
    await top("First question?").getByTestId("suggested").tap();
    await top("Second question?").waitFor();
    await settle();
    // Swipe it aside: it flies off, and the toast offers Undo.
    const box = await page.getByTestId("top").boundingBox();
    if (!box) throw new Error("the top card has no box");
    const x = box.x + box.width / 2;
    const y = box.y + box.height * 0.3;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step++) await page.mouse.move(x + step * 20, y);
    await page.mouse.up();
    await page.getByTestId("undo").waitFor();
    await settle();
    if ((await page.getByTestId("top").count()) !== 0) problems.push("the swiped card stayed");
    // Undo: it comes back in from the side it went.
    await page.getByTestId("undo").tap();
    await top("Second question?").waitFor();
    await settle();
  } catch (error) {
    problems.push(String(error));
  } finally {
    await context.close();
  }
  // A bad keyframe is logged once per frame: say each once, with how often.
  const counts = new Map<string, number>();
  for (const error of seen.errors) counts.set(error, (counts.get(error) ?? 0) + 1);
  for (const [error, count] of counts) problems.push(count > 1 ? `${error} (×${count})` : error);
  return problems;
}

/**
 * A permission card reads as words first and still shows what would really run: the headline, the
 * command with its line breaks, Allow and Deny one tap each, and all of it on the screen even for
 * a long command. `TENZO_SMOKE_SHOTS` names a folder for screenshots, to look at it by eye.
 */
async function permissionCard(browser: Browser, base: string): Promise<string[]> {
  const context = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await context.newPage();
  const seen = watch(page);
  const problems: string[] = [];
  const environmentId = "env_smoke000000000000000";
  const threadId = "thr_smokepass00000000000";
  const at = new Date().toISOString();
  const thread = { ...fakeThread(environmentId, threadId, at), title: "Ciao.sh greeting setup" };
  const command = [
    `printf '#!/bin/sh\\necho "bongiorno"\\n' > ciao.sh && chmod +x ciao.sh`,
    `printf '#!/bin/sh\\nset -e\\ngrep -q Tenzo README.md\\nsh ciao.sh\\n' > check.sh`,
    `echo "--- pass case"; sh check.sh; echo "exit=$?"`,
    `echo "--- fail case (grep no match, temp copy)"`,
    `T=$(mktemp -d); cp check.sh ciao.sh "$T"; echo nope > "$T/README.md"`,
    `(cd "$T" && sh check.sh); echo "exit=$?"`,
    `rm -rf "$T"`,
    `git status --short`,
    `git diff --stat`,
  ].join("\n");
  const permission = (tag: string, ask: string, request: object) => ({
    id: `itm_${tag.repeat(20)}`,
    environmentId,
    threadId,
    lane: "quick",
    kind: "permission",
    requestId: `req_${tag.repeat(20)}`,
    context: "",
    ask,
    options: [
      { label: "Allow", value: "allow", description: "", recommended: true },
      { label: "Deny", value: "deny", description: "", recommended: false },
    ],
    suggested: "allow",
    questions: [],
    permission: request,
    createdAt: at,
    status: "open",
    detached: false,
    resolvedAt: null,
    resolution: null,
    snoozedUntil: null,
  });
  const long = permission("a", "Create ciao.sh and check that check.sh passes and fails", {
    toolKind: "command",
    toolName: "Bash",
    detail: `Bash: ${command.replaceAll("\n", " ")}`,
    input: { command, description: "Create ciao.sh and check that check.sh passes and fails" },
  });
  const short = permission("b", "Force push main to origin", {
    toolKind: "command",
    toolName: "Bash",
    detail: "Bash: git push --force origin main",
    reason: "This overwrites history on a shared branch.",
    input: { command: "git push --force origin main", description: "Force push main to origin" },
  });
  let swap: () => void = () => {};
  await page.routeWebSocket(/\/ws$/, (ws) => {
    ws.send(JSON.stringify({ type: "hello", environmentId, version: "smoke", serverTime: at }));
    ws.send(
      JSON.stringify({
        type: "snapshot",
        snapshot: { environmentId, threads: [thread], items: [long], projects: [], live: null },
      }),
    );
    ws.onMessage((data) => {
      const frame = JSON.parse(String(data)) as { type: string };
      if (frame.type === "ping") ws.send(JSON.stringify({ type: "pong", at }));
    });
    swap = () => {
      ws.send(JSON.stringify({ type: "item", change: "resolved", item: { ...long, status: "resolved" } }));
      ws.send(JSON.stringify({ type: "item", change: "opened", item: short }));
    };
  });
  const shots = process.env.TENZO_SMOKE_SHOTS;
  const onScreen = async (id: string) => {
    const box = await page.getByTestId("top").getByTestId(id).boundingBox();
    const height = page.viewportSize()?.height ?? 0;
    if (!box || box.y + box.height > height) problems.push(`${id} is off the screen`);
  };
  try {
    await page.goto(`${base}/`);
    const top = page.getByTestId("top");
    await top.getByTestId("permission-code").waitFor();
    const headline = await top.getByTestId("ask").innerText();
    if (headline.includes("printf")) problems.push("the headline is the raw command");
    const shown = await top.getByTestId("permission-code").innerText();
    if (!shown.startsWith(command.split("\n")[0] ?? "?") || !shown.includes("\n")) {
      problems.push("the code isn't the command as written");
    }
    if ((await top.getByTestId("permission-cut").count()) === 0) problems.push("a cut command doesn't say so");
    if ((await top.getByTestId("suggested").innerText()) !== "Allow") problems.push("no Allow button");
    if ((await top.getByTestId("option").innerText()) !== "Deny") problems.push("Deny isn't one tap away");
    if ((await top.getByTestId("others").count()) > 0) problems.push("Deny is folded away");
    if ((await top.getByText("Suggested").count()) > 0) problems.push("Allow is marked Suggested");
    await onScreen("suggested");
    await onScreen("option");
    // Code in sight above the buttons, not merely above the bottom of the screen.
    const codeTop = (await top.getByTestId("permission-code").boundingBox())?.y ?? Infinity;
    const buttonsTop = (await top.getByTestId("decide").boundingBox())?.y ?? 0;
    if (codeTop + 60 > buttonsTop) problems.push("the code is pushed out of sight");
    if (shots) await page.screenshot({ path: `${shots}/permission-long.png` });
    await top.getByTestId("more").tap();
    await top.getByTestId("details").waitFor();
    if ((await top.getByTestId("details-code").innerText()) !== command) problems.push("What exactly isn't the command");
    if (shots) {
      await sleep(900); // the card has finished turning over
      await page.screenshot({ path: `${shots}/permission-back.png` });
    }
    swap();
    await page.getByTestId("permission-reason").waitFor();
    if ((await page.getByTestId("top").getByTestId("permission-cut").count()) > 0) problems.push("a short command says it's cut");
    if (shots) {
      await sleep(900); // the new card has arrived
      await page.screenshot({ path: `${shots}/permission-reason.png` });
    }
  } catch (error) {
    problems.push(String(error));
  } finally {
    await context.close();
  }
  if (seen.errors.length > 0) problems.push(`page errors: ${seen.errors.join("; ")}`);
  return problems;
}

/** A command a stubbed daemon got, and how it answers: a result, or a refusal. */
type Stub = (command: { type: string; [key: string]: unknown }) => unknown;

/**
 * Plays the daemon over a routed WebSocket: a snapshot of `threads` and `items`, then each
 * command answered by `answer` (its result, or an `Error` to refuse it). Returns what it got and
 * a way to send more frames.
 */
async function stubDaemon(page: Page, snapshot: { threads: object[]; items: object[] }, answer: Stub) {
  const environmentId = "env_smoke000000000000000";
  const at = new Date().toISOString();
  const got: { type: string; [key: string]: unknown }[] = [];
  let send: (frame: unknown) => void = () => {};
  await page.routeWebSocket(/\/ws$/, (ws) => {
    send = (frame) => ws.send(JSON.stringify(frame));
    send({ type: "hello", environmentId, version: "smoke", serverTime: at });
    send({ type: "snapshot", snapshot: { environmentId, ...snapshot, projects: [], live: null } });
    ws.onMessage((data) => {
      const frame = JSON.parse(String(data)) as { type: string; id?: string; command?: { type: string } };
      if (frame.type === "ping") send({ type: "pong", at });
      if (frame.type !== "command" || !frame.command) return;
      got.push(frame.command);
      const result = answer(frame.command);
      if (result instanceof Error) send({ type: "error", id: frame.id ?? null, error: result.message });
      else send({ type: "ok", id: frame.id, result });
    });
  });
  return { got, send: (frame: unknown) => send(frame) };
}

/** An open item as the daemon sends it. */
function stubItem(threadId: string, tag: string, fields: object) {
  return {
    id: `itm_${tag.repeat(20)}`,
    environmentId: "env_smoke000000000000000",
    threadId,
    lane: "quick",
    requestId: `req_${tag.repeat(20)}`,
    context: "",
    options: [],
    suggested: null,
    questions: [],
    createdAt: new Date().toISOString(),
    status: "open",
    detached: false,
    resolvedAt: null,
    resolution: null,
    snoozedUntil: null,
    ...fields,
  };
}

/** Waits for the stubbed daemon to have got a command of `type`; the latest one. */
async function received(got: { type: string }[], type: string) {
  for (let i = 0; i < 100; i++) {
    const found = got.findLast((c) => c.type === type);
    if (found) return found as { type: string; [key: string]: unknown };
    await sleep(30);
  }
  throw new Error(`the daemon never got ${type}`);
}

type Box = { x: number; y: number; width: number; height: number };

/** Whether `inner` lies inside `outer`, give or take a pixel. */
function within(inner: Box | null, outer: Box | null): boolean {
  if (!inner || !outer) return false;
  return (
    inner.x >= outer.x - 1 &&
    inner.y >= outer.y - 1 &&
    inner.x + inner.width <= outer.x + outer.width + 1 &&
    inner.y + inner.height <= outer.y + outer.height + 1
  );
}

/**
 * The card as the editor (#72), on a phone: focusing the answer field turns the card into it,
 * with one line of what is being answered (`line`) and ⌄ for all of it. Typed lines stay in the
 * field's box, which scrolls; Enter is a new line; with the keyboard up (a short window) Send is
 * on screen, and the keyboard going down puts the card back. Swipes are off. Cancel puts the card
 * back with the draft, in a box that holds it; focusing again reopens the editor, ready to Send.
 * Returns the lines typed. `shot`: where to save the editor with the keyboard up.
 */
async function writeInEditor(
  page: Page,
  line: string,
  got: { type: string }[],
  problems: string[],
  shot?: string,
): Promise<string[]> {
  const top = page.getByTestId("top");
  const card = top.getByTestId("card");
  const field = top.getByTestId("free-text");
  const editing = top.locator('[data-testid="card"][data-editing="true"]');
  await field.tap();
  await editing.waitFor();
  const folded = (await top.getByTestId("editor-line").innerText()).trim();
  if (folded !== line) problems.push(`the editor's line read "${folded}"`);
  if ((await top.getByTestId("suggested").count()) > 0) problems.push("the editor still shows the suggested answer");
  if (!(await top.getByTestId("card-text").isHidden())) problems.push("the editor didn't fold the card's text");
  const lines = Array.from({ length: 20 }, (_, i) => `Line ${i + 1} of what I think about it.`);
  for (const [i, text] of lines.entries()) {
    if (i > 0) await page.keyboard.press("Enter");
    await page.keyboard.type(text);
  }
  if (got.some((c) => c.type === "item.answer")) problems.push("Enter sent the answer on a phone");
  const cardBox = await card.boundingBox();
  const fieldBox = await field.boundingBox();
  const barBox = await top.getByTestId("editor-bar").boundingBox();
  if (!within(fieldBox, cardBox)) problems.push("the editor's field isn't inside the card");
  if (!fieldBox || !barBox || fieldBox.y + fieldBox.height > barBox.y + 1) problems.push("the field runs under Cancel and Send");
  if (!fieldBox || !cardBox || fieldBox.height < cardBox.height * 0.5) {
    problems.push(`the field doesn't fill the card (${fieldBox?.height} of ${cardBox?.height} px)`);
  }
  const { scrollHeight, clientHeight } = await field.evaluate((el) => {
    const area = el as unknown as { scrollHeight: number; clientHeight: number };
    return { scrollHeight: area.scrollHeight, clientHeight: area.clientHeight };
  });
  if (scrollHeight <= clientHeight) problems.push("20 lines didn't scroll inside the field");
  // As with the keyboard up: the card in what is left of the screen, Send still in it.
  const phone = page.viewportSize();
  await page.setViewportSize({ width: phone?.width ?? 393, height: 380 });
  await page.locator('main[data-compact="true"]').waitFor();
  const sendBox = await top.getByTestId("send").boundingBox();
  if (!sendBox || sendBox.y + sendBox.height > 380) problems.push("with the keyboard up, Send is off screen");
  if (!within(await field.boundingBox(), await card.boundingBox())) problems.push("with the keyboard up, the field leaves the card");
  if (shot) await page.screenshot({ path: shot });
  // The keyboard goes down (the field still focused, as Android's back button leaves it): the
  // card is back, the draft kept. Focused again, it is the editor again.
  if (phone) await page.setViewportSize(phone);
  await top.locator('[data-testid="card"][data-editing="false"]').waitFor();
  if ((await field.inputValue()) !== lines.join("\n")) problems.push("the keyboard going down lost the draft");
  await field.tap();
  await editing.waitFor();
  // ⌄ shows all of what is being answered, and the draft stays.
  await top.getByTestId("editor-unfold").tap();
  await top.getByTestId("card-text").waitFor();
  if ((await top.getByTestId("editor-line").count()) > 0) problems.push("unfolded, the one line stayed");
  // ⌄ keeps the focus (and so the keyboard) in the field.
  const focused = await field.evaluate(
    (el) => (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement === el,
  );
  if (!focused) problems.push("⌄ took the focus from the field");
  await top.getByTestId("editor-unfold").tap();
  await top.getByTestId("editor-line").waitFor();
  // No swiping the editor aside: a drag across its header does nothing.
  const head = await top.getByTestId("editor-unfold").boundingBox();
  if (head && cardBox) {
    const x = cardBox.x + cardBox.width * 0.3;
    const y = head.y + head.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step++) await page.mouse.move(x + step * 20, y);
    await page.mouse.up();
    await sleep(300);
    if (got.some((c) => c.type === "item.snooze")) problems.push("the editor was swiped aside");
  }
  // Cancel: the card as it was, the draft in a box that holds it.
  await top.getByTestId("editor-cancel").tap();
  await top.locator('[data-testid="card"][data-editing="false"]').waitFor();
  if ((await field.inputValue()) !== lines.join("\n")) problems.push("Cancel lost the draft");
  if ((await top.getByTestId("suggested").count()) === 0) problems.push("after Cancel, the answers aren't back");
  if (!within(await field.boundingBox(), await top.getByTestId("answer-form").boundingBox())) {
    problems.push("after Cancel, the draft runs out of its box");
  }
  // Focused again, it is the editor again, the draft still there.
  await field.tap();
  await editing.waitFor();
  return lines;
}

/**
 * A reply card (#66): an answer is something that needs you. What you asked, small; the agent's
 * words as markdown; the reply field first, then Got it (suggested); Archive thread and See the
 * whole thread, quietly. Words go as the next prompt and the card lifts; Archive asks first in
 * a sheet that says how many files would be lost, and archives with force.
 */
async function replyCard(browser: Browser, base: string): Promise<string[]> {
  const context = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await context.newPage();
  const seen = watch(page);
  const problems: string[] = [];
  const at = new Date().toISOString();
  const threadId = "thr_smokereply0000000000";
  const thread = {
    ...fakeThread("env_smoke000000000000000", threadId, at),
    title: "Flaky checkout test",
    branch: "tenzo/flaky-checkout-test",
    phase: "discussing",
    activity: "needs-you",
    working: false,
    openItems: 1,
  };
  const message =
    "## It races the payment mock's timer\n\n`checkout.test.ts` waits 50 ms for the mock, which replies after 0–80 ms.\n\nFix: await the mock's promise. Want me to do it?";
  const reply = (tag: string) =>
    stubItem(threadId, tag, {
      kind: "reply",
      ask: "It races the payment mock's timer",
      options: [{ label: "Got it", value: "done", description: "", recommended: true }],
      suggested: "done",
      reply: { message, prompt: "Why is the checkout test flaky?" },
    });
  const first = reply("a");
  const second = reply("b");
  const { got, send } = await stubDaemon(page, { threads: [thread], items: [first] }, (command) => {
    if (command.type === "item.answer") {
      const resolved = { ...first, status: "resolved", resolution: { kind: "continued" } };
      send({ type: "item", change: "resolved", item: resolved });
      return { item: resolved, delivery: "message", thread };
    }
    if (command.type === "thread.uncommitted") return { files: 2 };
    if (command.type === "thread.archive") {
      send({ type: "item", change: "resolved", item: { ...second, status: "resolved", resolution: { kind: "dismissed" } } });
      return { thread: { ...thread, status: "archived" } };
    }
    return new Error(`no ${command.type} here`);
  });
  const shots = process.env.TENZO_SMOKE_SHOTS;
  try {
    await page.goto(`${base}/`);
    const top = page.getByTestId("top");
    await top.locator('[data-kind="reply"]').waitFor();
    const asked = (await top.getByTestId("asked").innerText()).trim();
    if (asked !== "Why is the checkout test flaky?") problems.push(`You asked read "${asked}"`);
    if ((await top.getByTestId("ask").innerText()).trim() !== "It races the payment mock's timer") {
      problems.push("the heading isn't the card's headline");
    }
    if ((await top.getByTestId("reply-message").locator("code").count()) === 0) problems.push("the answer isn't markdown");
    if ((await top.getByTestId("more").count()) > 0) problems.push("a reply shows a More pill");
    const suggested = await top.getByTestId("suggested").innerText();
    if (!/Suggested/i.test(suggested) || !suggested.includes("Got it")) problems.push(`the filled button read "${suggested}"`);
    const fieldY = (await top.getByTestId("free-text").boundingBox())?.y ?? Infinity;
    const gotItY = (await top.getByTestId("suggested").boundingBox())?.y ?? 0;
    if (fieldY > gotItY) problems.push("the reply field isn't above Got it");
    if ((await top.getByTestId("card-archive").innerText()) !== "Archive thread") problems.push("no Archive thread");
    const whole = top.getByTestId("whole-thread");
    if ((await whole.getAttribute("href")) !== `/threads/${threadId}`) problems.push("See the whole thread goes elsewhere");
    if (shots) await page.screenshot({ path: `${shots}/reply-card.png` });
    // Words go on in the same thread, written in the card as the editor (#72), and the card lifts.
    await sleep(400); // a new card ignores taps while it settles
    const lines = await writeInEditor(page, "You asked: Why is the checkout test flaky?", got, problems);
    await top.getByTestId("send").tap();
    const answered = await received(got, "item.answer");
    const answer = answered.answer as { kind?: string; decision?: string; text?: string };
    if (answer.kind !== "reply" || answer.decision !== "send" || answer.text !== lines.join("\n")) {
      problems.push(`the card sent ${JSON.stringify(answer).slice(0, 120)}`);
    }
    await top.waitFor({ state: "detached" });
    // A second reply: Archive thread asks first, with what would be lost.
    send({ type: "item", change: "opened", item: second });
    await top.locator(`[data-id="${second.id}"]`).waitFor();
    await sleep(400); // a new card ignores taps while it settles
    await top.getByTestId("card-archive").tap();
    await page.getByTestId("archive-sheet").waitFor();
    await page.getByTestId("archive-warning").waitFor();
    const warning = await page.getByTestId("archive-warning").innerText();
    if (!warning.startsWith("2 files have changes")) problems.push(`the warning read "${warning}"`);
    if ((await page.getByTestId("archive-confirm").innerText()) !== "Archive anyway") problems.push("no Archive anyway");
    if (shots) {
      await sleep(400); // the sheet has come up
      await page.screenshot({ path: `${shots}/archive-sheet.png` });
    }
    // A modal sheet: the focus is in it, and typing can't reach the reply field behind it.
    const focused = await page.evaluate(
      () => (globalThis as unknown as { document: { activeElement: { dataset?: { testid?: string } } | null } })
        .document.activeElement?.dataset?.testid,
    );
    if (focused !== "archive-keep") problems.push(`with the sheet up, the focus was on ${focused}`);
    if (!(await page.locator("main").evaluate((el) => (el as unknown as { inert: boolean }).inert))) {
      problems.push("the page behind the sheet isn't inert");
    }
    const answers = got.filter((c) => c.type === "item.answer").length;
    await page.keyboard.type("oops");
    if ((await top.getByTestId("free-text").inputValue()) !== "") problems.push("typing behind the sheet reached the reply field");
    await page.getByTestId("archive-keep").tap();
    await page.getByTestId("archive-sheet").waitFor({ state: "detached" });
    if (got.some((c) => c.type === "thread.archive")) problems.push("Keep it archived the thread");
    if (got.filter((c) => c.type === "item.answer").length !== answers) problems.push("typing behind the sheet sent a reply");
    await top.getByTestId("card-archive").tap();
    await page.getByTestId("archive-warning").waitFor();
    await page.getByTestId("archive-confirm").tap();
    const archive = await received(got, "thread.archive");
    if (archive.threadId !== threadId || archive.force !== true) problems.push(`archived with ${JSON.stringify(archive)}`);
    await page.getByTestId("archive-sheet").waitFor({ state: "detached" });
  } catch (error) {
    problems.push(String(error));
  } finally {
    await context.close();
  }
  if (seen.errors.length > 0) problems.push(`page errors: ${seen.errors.join("; ")}`);
  return problems;
}

/**
 * With a mouse (#72), in a short desktop window: no editor; the reply field has the focus, and
 * eight lines (Shift+Enter) stay in its box, which never runs over Got it. Archive thread clicked
 * with the focus there, typing behind the sheet can't reach the field.
 */
async function inlineField(browser: Browser, base: string): Promise<string[]> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 640 } });
  const page = await context.newPage();
  const seen = watch(page);
  const problems: string[] = [];
  const at = new Date().toISOString();
  const threadId = "thr_smokeinline000000000";
  const thread = {
    ...fakeThread("env_smoke000000000000000", threadId, at),
    title: "Desktop field",
    phase: "discussing",
    activity: "needs-you",
    working: false,
    openItems: 1,
  };
  const item = stubItem(threadId, "i", {
    kind: "reply",
    ask: "Done",
    options: [{ label: "Got it", value: "done", description: "", recommended: true }],
    suggested: "done",
    reply: { message: "Done. The test waits for the mock now.", prompt: "Fix the flaky test" },
  });
  const { got } = await stubDaemon(page, { threads: [thread], items: [item] }, (command) =>
    command.type === "thread.uncommitted" ? { files: 0 } : new Error(`no ${command.type} here`),
  );
  try {
    await page.goto(`${base}/`);
    const top = page.getByTestId("top");
    const field = top.getByTestId("free-text");
    await top.locator('[data-kind="reply"]').waitFor();
    await sleep(400); // a new card ignores taps while it settles
    const focused = await field.evaluate(
      (el) => (globalThis as unknown as { document: { activeElement: unknown } }).document.activeElement === el,
    );
    if (!focused) problems.push("the reply field doesn't have the focus");
    for (let i = 0; i < 8; i++) {
      if (i > 0) await page.keyboard.press("Shift+Enter");
      await page.keyboard.type(`Line ${i + 1}`);
    }
    if ((await top.getByTestId("card").getAttribute("data-editing")) !== "false") problems.push("a mouse opened the editor");
    if (got.some((c) => c.type === "item.answer")) problems.push("Shift+Enter sent the answer");
    const form = await top.getByTestId("answer-form").boundingBox();
    if (!within(await field.boundingBox(), form)) problems.push("eight lines ran out of the field's box");
    const gotIt = await top.getByTestId("suggested").boundingBox();
    if (!form || !gotIt || form.y + form.height > gotIt.y) problems.push("the field runs over Got it");
    await top.getByTestId("card-archive").evaluate((el) => (el as unknown as { click(): void }).click());
    await page.getByTestId("archive-sheet").waitFor();
    const before = await field.inputValue();
    await page.keyboard.type("oops");
    if ((await field.inputValue()) !== before) problems.push("typing behind the sheet reached the reply field");
    await page.getByTestId("archive-keep").click();
    await page.getByTestId("archive-sheet").waitFor({ state: "detached" });
  } catch (error) {
    problems.push(String(error));
  } finally {
    await context.close();
  }
  if (seen.errors.length > 0) problems.push(`page errors: ${seen.errors.join("; ")}`);
  return problems;
}

/** A 1×1 PNG: what an attached image's URL serves here. */
const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Images while discussing, and a multi-line answer (#69): a proposal shows what the agent
 * attached before it, a tap enlarges one; the answer takes several lines, written in the card as
 * the editor on a phone (#72), and sends every line.
 */
async function mockupCard(browser: Browser, base: string): Promise<string[]> {
  const context = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await context.newPage();
  const seen = watch(page);
  const problems: string[] = [];
  const at = new Date().toISOString();
  const threadId = "thr_smokemockup000000000";
  const thread = {
    ...fakeThread("env_smoke000000000000000", threadId, at),
    title: "Desktop layout",
    phase: "discussing",
    activity: "needs-you",
    working: false,
    openItems: 1,
  };
  const image = (n: number) => ({
    id: `att_${String(n).repeat(20)}`,
    file: `att_${String(n).repeat(20)}.png`,
    name: `layout-${n}.png`,
    caption: `Layout ${n}`,
    mediaType: "image/png",
    bytes: PNG_1PX.length,
  });
  const item = stubItem(threadId, "m", {
    kind: "proposal",
    ask: "Two columns on a wide screen",
    options: [{ label: "Build it", value: "build", description: "", recommended: true }],
    suggested: "build",
    proposal: { headline: "Two columns on a wide screen", summary: "The Pass on the left, the thread on the right." },
    attachments: [image(1), image(2), image(3)],
  });
  const { got } = await stubDaemon(page, { threads: [thread], items: [item] }, (command) => {
    if (command.type === "item.answer") {
      return { item: { ...item, status: "resolved", resolution: { kind: "revise", note: "" } }, delivery: "live", thread };
    }
    return new Error(`no ${command.type} here`);
  });
  await page.route(/\/api\/attachments\//, (route) =>
    route.fulfill({ status: 200, contentType: "image/png", body: PNG_1PX }),
  );
  const shots = process.env.TENZO_SMOKE_SHOTS;
  try {
    await page.goto(`${base}/`);
    const top = page.getByTestId("top");
    await top.locator('[data-kind="proposal"]').waitFor();
    const thumbs = top.getByTestId("media").getByTestId("shot");
    if ((await thumbs.count()) !== 3) problems.push(`the proposal showed ${await thumbs.count()} images, not 3`);
    const src = await thumbs.first().locator("img").getAttribute("src");
    if (src !== `/api/attachments/${threadId}/${image(1).file}`) problems.push(`the first image is ${src}`);
    if (shots) await page.screenshot({ path: `${shots}/proposal-images.png` });
    await sleep(400); // a new card ignores taps while it settles
    await thumbs.nth(1).tap();
    await page.getByTestId("enlarged").waitFor();
    if (!(await page.getByTestId("enlarged").innerText()).includes("Layout 2")) problems.push("the enlarged image has no caption");
    await page.getByTestId("enlarged").tap();
    await page.getByTestId("enlarged").waitFor({ state: "detached" });

    // Several lines, written in the card as the editor (#72): Enter is a new line, never a send.
    const lines = await writeInEditor(page, "Two columns on a wide screen", got, problems, shots && `${shots}/editor.png`);
    await top.getByTestId("send").tap();
    const answered = await received(got, "item.answer");
    const answer = answered.answer as { kind?: string; note?: string };
    if (answer.kind !== "proposal" || answer.note !== lines.join("\n")) {
      problems.push(`the card sent ${JSON.stringify(answer).slice(0, 120)}`);
    }
  } catch (error) {
    problems.push(String(error));
  } finally {
    await context.close();
  }
  if (seen.errors.length > 0) problems.push(`page errors: ${seen.errors.join("; ")}`);
  return problems;
}

/**
 * The thread page takes messages (#66): a field with mic and send at the foot of So far while
 * nothing is open for the thread; while it works, the hint says the message waits its turn and
 * the message shows as queued. Something open puts the way to the Pass there instead.
 */
async function threadComposer(browser: Browser, base: string): Promise<string[]> {
  const context = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await context.newPage();
  const seen = watch(page);
  const problems: string[] = [];
  const at = new Date().toISOString();
  const threadId = "thr_smokecomposer0000000";
  const thread = {
    ...fakeThread("env_smoke000000000000000", threadId, at),
    title: "Flaky checkout test",
    lastSeq: 0,
  };
  const question = stubItem(thread.id, "q", {
    kind: "question",
    ask: "Which test?",
    questions: [{ id: "Which test?", header: "", question: "Which test?", options: [], multiSelect: false }],
  });
  const { got, send } = await stubDaemon(page, { threads: [thread], items: [] }, (command) => {
    if (command.type === "thread.watch") return { thread, events: [], older: false, reset: true };
    if (command.type === "thread.unwatch") return { watching: false };
    if (command.type === "thread.send") {
      const queued = { ...thread, queued: 1 };
      send({ type: "thread", thread: queued });
      return { thread: queued };
    }
    // Its repo was moved: nothing to count, and only force archives it (as the daemon says).
    if (command.type === "thread.uncommitted") return { files: 0 };
    if (command.type === "thread.archive") {
      return command.force
        ? { thread: { ...thread, status: "archived" } }
        : new Error(
            "The repo /src/app is gone (moved or deleted). Archive with --force to forget this thread and delete /tmp/busy.",
          );
    }
    return new Error(`no ${command.type} here`);
  });
  try {
    await page.goto(`${base}/threads/${thread.id}`);
    await page.locator('[data-testid="timeline"][data-status="live"]').waitFor();
    const field = page.getByTestId("message");
    await field.waitFor();
    const hint = await field.getAttribute("placeholder");
    if (hint !== "Message… (waits its turn)") problems.push(`a working thread's hint read "${hint}"`);
    const listens = await page.evaluate(() => "webkitSpeechRecognition" in globalThis || "SpeechRecognition" in globalThis);
    if (listens && (await page.getByTestId("composer").getByTestId("mic").count()) === 0) problems.push("no mic");
    if ((await page.getByTestId("archive").count()) === 0) problems.push("no Archive in the header");
    await field.fill("And check the other tests for the same sleep");
    await page.getByTestId("message-send").tap();
    const sent = await received(got, "thread.send");
    if (sent.threadId !== thread.id || sent.prompt !== "And check the other tests for the same sleep") {
      problems.push(`sent ${JSON.stringify(sent)}`);
    }
    await page.getByTestId("queued").filter({ hasText: "And check the other tests" }).waitFor();
    if ((await field.inputValue()) !== "") problems.push("the field kept the sent message");
    if (process.env.TENZO_SMOKE_SHOTS) await page.screenshot({ path: `${process.env.TENZO_SMOKE_SHOTS}/thread-page.png` });
    // Archive with its repo gone: the daemon refuses, the sheet says why and offers Archive anyway.
    await page.getByTestId("archive").tap();
    await page.getByTestId("archive-sheet").waitFor();
    if ((await page.getByTestId("archive-confirm").innerText()) !== "Archive") problems.push("a clean worktree asks for more than Archive");
    await page.getByTestId("archive-confirm").tap();
    await page.getByTestId("archive-warning").filter({ hasText: "repo is gone" }).waitFor();
    if ((await page.getByTestId("archive-confirm").innerText()) !== "Archive anyway") problems.push("a gone repo offers no Archive anyway");
    await page.getByTestId("archive-confirm").tap();
    const forced = await received(got, "thread.archive");
    if (forced.force !== true) problems.push(`a gone repo archived with ${JSON.stringify(forced)}`);
    await page.getByTestId("archive-sheet").waitFor({ state: "detached" });
    // Something open for it: its answer belongs on the Pass.
    send({ type: "item", change: "opened", item: question });
    await page.getByTestId("to-pass").waitFor();
    if ((await page.getByTestId("composer").count()) > 0) problems.push("the field stayed with a question open");
  } catch (error) {
    problems.push(String(error));
  } finally {
    await context.close();
  }
  if (seen.errors.length > 0) problems.push(`page errors: ${seen.errors.join("; ")}`);
  return problems;
}

/**
 * Archive by hand against the real daemon (#66): a thread with a file it never committed. The
 * sheet says so (the daemon counted it), Archive anyway archives it with force, its worktree is
 * gone, and the page shows it archived, with no field and no Archive left.
 */
async function archiveForReal(
  browser: Browser,
  base: string,
  thread: { id: string; worktreePath: string },
): Promise<string[]> {
  const context = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await context.newPage();
  const seen = watch(page);
  const problems: string[] = [];
  try {
    writeFileSync(join(thread.worktreePath, "notes.txt"), "never committed\n");
    await page.goto(`${base}/threads/${thread.id}`);
    await page.getByTestId("message").waitFor();
    await page.getByTestId("archive").tap();
    await page.getByTestId("archive-sheet").waitFor();
    const warning = (await page.getByTestId("archive-warning").innerText()).trim();
    if (warning !== "1 file has changes that aren't committed. It'll be lost.") problems.push(`the warning read "${warning}"`);
    const branch = await page.getByTestId("archive-sheet").locator("code").innerText();
    if (!branch.startsWith("tenzo/")) problems.push(`the sheet named the branch "${branch}"`);
    await page.getByTestId("archive-confirm").tap();
    await page.getByTestId("archive-sheet").waitFor({ state: "detached" });
    await page.getByTestId("thread-view").getByText("· archived").waitFor();
    if ((await page.getByTestId("composer").count()) > 0) problems.push("an archived thread still takes messages");
    if ((await page.getByTestId("archive").count()) > 0) problems.push("an archived thread still offers Archive");
    if (existsSync(thread.worktreePath)) problems.push("the worktree is still there");
    const { threads } = await local<{ threads: { id: string; status: string }[] }>(base, {
      type: "thread.list",
      includeArchived: true,
    });
    if (threads.find((t) => t.id === thread.id)?.status !== "archived") problems.push("the daemon didn't archive it");
  } catch (error) {
    problems.push(String(error));
  } finally {
    await context.close();
  }
  if (seen.errors.length > 0) problems.push(`page errors: ${seen.errors.join("; ")}`);
  return problems;
}

/** A command to the daemon from this Mac (no login), its result. */
async function local<T>(base: string, command: unknown): Promise<T> {
  const answer = (await (
    await fetch(`${base}/api/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(command),
    })
  ).json()) as { ok: boolean; result?: T; error?: string };
  if (!answer.ok) throw new Error(`${JSON.stringify(command)}: ${answer.error}`);
  return answer.result as T;
}

/**
 * Remote mode (PRODUCT.md §9): the app reached by a name that isn't loopback, as through
 * Tailscale Serve. `pair.localhost` resolves to this Mac and is a secure context, so the
 * `__Host-` cookie sticks without HTTPS. Unpaired, it shows how to pair and opens no socket; a
 * pairing link lands on the Pass; revoking the device from the Mac sends it back to pairing.
 */
async function remote(browser: Browser, base: string, remoteBase: string): Promise<string[]> {
  const context = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await context.newPage();
  const seen = watch(page);
  const problems: string[] = [];
  try {
    await page.goto(`${remoteBase}/`);
    await page.getByTestId("pair-device").waitFor();
    if (seen.sockets !== 0) problems.push(`an unpaired device opened ${seen.sockets} WebSockets`);
    const { code } = await local<{ code: string }>(base, { type: "device.pair", name: "Smoke phone" });
    await page.goto(`${remoteBase}/pair#${code}`);
    await page.getByTestId("pass").waitFor();
    if (page.url() !== `${remoteBase}/`) problems.push(`paired, it landed on ${page.url()}`);
    const cookie = (await context.cookies()).find((c) => c.name === "__Host-tenzo");
    if (!cookie?.httpOnly || !cookie.secure || cookie.sameSite !== "Strict") {
      problems.push(`the device cookie was ${JSON.stringify(cookie)}`);
    }
    const { devices: paired } = await local<{ devices: { id: string; name: string }[] }>(base, {
      type: "device.list",
    });
    const phone = paired.find((d) => d.name === "Smoke phone");
    if (!phone) throw new Error("the paired device isn't listed");
    await local(base, { type: "device.revoke", deviceId: phone.id });
    await page.getByTestId("pair-device").waitFor();
  } catch (error) {
    problems.push(String(error));
  } finally {
    await context.close();
  }
  if (seen.errors.length > 0) problems.push(`page errors: ${seen.errors.join("; ")}`);
  return problems;
}

/**
 * Clickjacking: a page on another port of the same host (as a live page is: same site, cookies
 * ignore ports) puts the Pass in an iframe. The daemon's `frame-ancestors 'none'` must keep it
 * from rendering there. The decoy is served by a plain server on a free loopback port.
 */
async function framed(browser: Browser, base: string): Promise<string[]> {
  const decoy = createHttpServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><title>decoy</title><iframe src="${base}/" style="width:390px;height:700px"></iframe>`);
  });
  await new Promise<void>((done) => decoy.listen(0, "127.0.0.1", done));
  const context = await browser.newContext({ ...devices["iPhone 15"] });
  const page = await context.newPage();
  const problems: string[] = [];
  try {
    await page.goto(`http://127.0.0.1:${(decoy.address() as AddressInfo).port}/`);
    const frame = page.frames().find((f) => f !== page.mainFrame());
    if (!frame) throw new Error("the decoy has no frame");
    // Long enough for the Pass to have drawn, had it loaded.
    await sleep(2000);
    const rendered = await frame
      .locator('[data-testid="pass"], [data-testid="pair-device"]')
      .count()
      .catch(() => 0);
    if (rendered > 0) problems.push(`the Pass rendered inside the decoy's frame (${frame.url()})`);
  } catch (error) {
    problems.push(String(error));
  } finally {
    await context.close();
    decoy.close();
  }
  return problems;
}

async function main(): Promise<number> {
  if (!existsSync(join(WEB_DIR, "index.html"))) {
    console.error("No web build. Run `pnpm --filter @tenzo/web build` first (`pnpm smoke` does).");
    return 1;
  }
  const root = mkdtempSync(join(tmpdir(), "tenzo-smoke-"));
  const port = await freePort();
  const env = {
    ...process.env,
    TENZO_HOME: join(root, "home"),
    TENZO_PORT: String(port),
    // Its own free port too: the next one up may be taken.
    TENZO_LIVE_PORT: String(await freePort()),
    // Remote mode, without HTTPS: a name that isn't loopback, whose plain-http page may call.
    TENZO_ALLOWED_HOSTS: "pair.localhost",
    TENZO_DEV_ORIGIN: `http://pair.localhost:${port}`,
  };
  let daemon: { stop: () => Promise<void> } | undefined;
  let browser: Browser | undefined;
  try {
    const repo = scratchRepo(root);
    execFileSync(process.execPath, [CLI, "project", "add", repo], { cwd: REPO_ROOT, env });
    daemon = await startDaemon(env, port);
    const executablePath = findChromium();
    const launched = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    browser = launched;
    const base = `http://127.0.0.1:${port}`;
    // A thread with a title and no prompt: no agent starts, so no `claude` is needed.
    const created = (await (
      await fetch(`${base}/api/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "thread.create", project: "app", title: "Smoke thread" }),
      })
    ).json()) as { ok: boolean; result?: { thread: { id: string } }; error?: string };
    const threadId = created.result?.thread.id;
    if (!threadId) throw new Error(`couldn't create a thread: ${created.error}`);
    // Another, to archive by hand.
    const { thread: doomed } = await local<{ thread: { id: string; worktreePath: string } }>(base, {
      type: "thread.create",
      project: "app",
      title: "Archive me",
    });
    const checks: [string, () => Promise<string[]>][] = [
      ...["/", "/new", "/threads"].map((start): [string, () => Promise<string[]>] => [
        `start at ${start}`,
        () => run(launched, base, start),
      ]),
      ["reload on New, then Close", () => reload(launched, base)],
      ["a Threads row opens its timeline, and back", () => thread(launched, base, threadId, false)],
      ["start at a thread's timeline, back to the Pass", () => thread(launched, base, threadId, true)],
      ["a long timeline holds your place as the full feed moves on", () => heldPlace(launched, base)],
      ["the Pass moves: a card arrives, lifts, is swiped aside and comes back", () => passMotion(launched, base, false)],
      ["the Pass with reduced motion: the same, in place", () => passMotion(launched, base, true)],
      ["a permission card: words, the real command, Allow and Deny on screen", () => permissionCard(launched, base)],
      ["a reply card: what you asked, the answer, reply in the editor or Got it, Archive asks first", () => replyCard(launched, base)],
      ["with a mouse, the inline field grows with its text and keeps the focus behind a sheet", () => inlineField(launched, base)],
      ["a thread page takes messages: mic and send, queued while it works; a gone repo archives anyway", () => threadComposer(launched, base)],
      ["a proposal shows the images attached before it; several lines in the card as the editor", () => mockupCard(launched, base)],
      ["Archive by hand: the sheet counts what would be lost, Archive anyway archives", () => archiveForReal(launched, base, doomed)],
      ["start at Automations: next run, the off switch both ways, Close to the Pass", () => automations(launched, base, true)],
      ["Threads opens Automations, and Close goes back", () => automations(launched, base, false)],
      ["a page on another port (a live page) can't frame the Pass", () => framed(launched, base)],
      [
        "from elsewhere: how to pair, a pairing link lands on the Pass, revoked goes back to pairing",
        () => remote(launched, base, `http://pair.localhost:${port}`),
      ],
    ];
    let failed = false;
    for (const [name, check] of checks) {
      const problems = await check();
      failed ||= problems.length > 0;
      console.log(`${problems.length === 0 ? "PASS" : "FAIL"}  ${name}`);
      for (const problem of problems) console.log(`      ${problem}`);
    }
    return failed ? 1 : 0;
  } finally {
    await browser?.close();
    await daemon?.stop();
    rmSync(root, { recursive: true, force: true });
  }
}

process.exitCode = await main();
