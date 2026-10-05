import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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

function watch(page: Page): Watch {
  const seen: Watch = { errors: [], sockets: 0, documents: 0 };
  page.on("pageerror", (error) => seen.errors.push(error.message));
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
  const thread = {
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
    const checks: [string, () => Promise<string[]>][] = [
      ...["/", "/new", "/threads"].map((start): [string, () => Promise<string[]>] => [
        `start at ${start}`,
        () => run(launched, base, start),
      ]),
      ["reload on New, then Close", () => reload(launched, base)],
      ["a Threads row opens its timeline, and back", () => thread(launched, base, threadId, false)],
      ["start at a thread's timeline, back to the Pass", () => thread(launched, base, threadId, true)],
      ["a long timeline holds your place as the full feed moves on", () => heldPlace(launched, base)],
      ["start at Automations: next run, the off switch both ways, Close to the Pass", () => automations(launched, base, true)],
      ["Threads opens Automations, and Close goes back", () => automations(launched, base, false)],
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
