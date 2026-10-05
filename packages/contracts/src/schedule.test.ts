import { describe, expect, it } from "vitest";
import { checkAutomations, durationMs, ProjectConfig } from "./config.ts";
import { instantOf, isTimeZone, nextRun, parseSchedule, type Schedule, wallOf } from "./schedule.ts";

function parsed(text: string): Schedule {
  const schedule = parseSchedule(text);
  if (typeof schedule === "string") throw new Error(`${text}: ${schedule}`);
  return schedule;
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

describe("parseSchedule", () => {
  it("reads intervals, hourly, daily and weekdays, and cron lines", () => {
    expect(parsed("every 15m")).toMatchObject({ kind: "every", ms: 15 * 60_000 });
    expect(parsed("every 2h")).toMatchObject({ kind: "every", ms: 2 * 3_600_000 });
    expect(parsed("Every  1d")).toMatchObject({ kind: "every", ms: 86_400_000 });
    expect(parsed("hourly")).toMatchObject({ kind: "cron" });
    const daily = parsed("daily 09:30");
    expect(daily.kind === "cron" && daily.cron).toMatchObject({ minutes: [30], hours: [9], either: false });
    const weekdays = parsed("weekdays 7:05");
    expect(weekdays.kind === "cron" && [...weekdays.cron.weekdays]).toEqual([1, 2, 3, 4, 5]);
    const cron = parsed("*/20 8-10,14 1,15 * 7");
    expect(cron.kind === "cron" && cron.cron).toMatchObject({
      minutes: [0, 20, 40],
      hours: [8, 9, 10, 14],
      either: true,
    });
    expect(cron.kind === "cron" && [...cron.cron.weekdays]).toEqual([0]); // 7 is Sunday
  });

  it("says what is wrong with anything else", () => {
    for (const bad of [
      "",
      "every 0m",
      "every 4m", // schedules run at most every 5 minutes
      "every 31d",
      "every hour",
      "every 5s",
      "daily",
      "daily 25:00",
      "weekdays 9",
      "* * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "* * * * 8",
      "*/0 * * * *",
      "5-1 * * * *",
      "a b c d e",
      "0 0 30 2 *", // the 30th of February never comes
      "x".repeat(101),
      "; rm -rf /",
    ]) {
      expect(typeof parseSchedule(bad), bad).toBe("string");
    }
  });
});

describe("nextRun", () => {
  it("counts an interval from the time given", () => {
    const at = Date.UTC(2026, 9, 5, 10, 0, 30);
    expect(nextRun(parsed("every 1h"), "UTC", at)).toBe(at + 3_600_000);
  });

  it("finds the next minute a cron line matches, never the same instant", () => {
    const at = Date.UTC(2026, 9, 5, 9, 0); // a Monday
    expect(iso(nextRun(parsed("daily 09:00"), "UTC", at))).toBe("2026-10-06T09:00:00.000Z");
    expect(iso(nextRun(parsed("daily 09:00"), "UTC", at - 1))).toBe("2026-10-05T09:00:00.000Z");
    expect(iso(nextRun(parsed("hourly"), "UTC", at + 1))).toBe("2026-10-05T10:00:00.000Z");
    expect(iso(nextRun(parsed("* * * * *"), "UTC", at + 30_000))).toBe("2026-10-05T09:01:00.000Z");
    // Friday evening → Monday morning.
    expect(iso(nextRun(parsed("weekdays 08:00"), "UTC", Date.UTC(2026, 9, 9, 20)))).toBe(
      "2026-10-12T08:00:00.000Z",
    );
    // Day of month or day of week, as cron does when both are set: the 1st, or a Sunday.
    expect(iso(nextRun(parsed("0 12 1 * 0"), "UTC", Date.UTC(2026, 9, 5)))).toBe("2026-10-11T12:00:00.000Z");
    // A day field that starts with `*` (`*/2`) narrows, as in Vixie cron: odd days that are Mondays.
    expect(iso(nextRun(parsed("0 12 */2 * 1"), "UTC", Date.UTC(2026, 9, 6)))).toBe("2026-10-19T12:00:00.000Z");
    // Leap day.
    expect(iso(nextRun(parsed("0 0 29 2 *"), "UTC", Date.UTC(2026, 0, 1)))).toBe("2028-02-29T00:00:00.000Z");
  });

  it("reads clock times in the schedule's time zone, across daylight saving", () => {
    const rome = "Europe/Rome";
    // 09:00 in Rome is 07:00Z in summer and 08:00Z in winter; DST ends on 2026-10-25.
    expect(iso(nextRun(parsed("daily 09:00"), rome, Date.UTC(2026, 9, 24, 12)))).toBe("2026-10-25T08:00:00.000Z");
    expect(iso(nextRun(parsed("daily 09:00"), rome, Date.UTC(2026, 9, 23, 12)))).toBe("2026-10-24T07:00:00.000Z");
    // An interval doesn't move with the clocks.
    const before = Date.UTC(2026, 9, 25, 0, 30);
    expect(nextRun(parsed("every 2h"), rome, before)).toBe(before + 7_200_000);
  });

  it("runs a time the clocks skip once, as they jump past it, and a doubled time once, the first", () => {
    const ny = "America/New_York";
    // 2026-03-08: 02:00 EST jumps to 03:00 EDT. 02:30 doesn't exist: it runs at 03:30 EDT (07:30Z).
    const spring = nextRun(parsed("30 2 * * *"), ny, Date.UTC(2026, 2, 8, 5));
    expect(iso(spring)).toBe("2026-03-08T07:30:00.000Z");
    expect(wallOf(spring ?? 0, ny)).toMatchObject({ hour: 3, minute: 30 });
    // The next day it is 02:30 again.
    expect(iso(nextRun(parsed("30 2 * * *"), ny, spring ?? 0))).toBe("2026-03-09T06:30:00.000Z");
    // 2026-11-01: 02:00 EDT falls back to 01:00 EST, so 01:30 happens twice: the first (05:30Z).
    const fall = nextRun(parsed("30 1 * * *"), ny, Date.UTC(2026, 10, 1, 4));
    expect(iso(fall)).toBe("2026-11-01T05:30:00.000Z");
    // Not again an hour later: the next is tomorrow's.
    expect(iso(nextRun(parsed("30 1 * * *"), ny, fall ?? 0))).toBe("2026-11-02T06:30:00.000Z");
  });

  it("converts clock times both ways", () => {
    const at = instantOf({ year: 2026, month: 7, day: 1, hour: 9, minute: 15 }, "Asia/Kolkata");
    expect(iso(at)).toBe("2026-07-01T03:45:00.000Z");
    expect(wallOf(at, "Asia/Kolkata")).toEqual({ year: 2026, month: 7, day: 1, hour: 9, minute: 15 });
  });

  it("knows a time zone from a typo", () => {
    expect(isTimeZone("Europe/Rome")).toBe(true);
    expect(isTimeZone("UTC")).toBe(true);
    expect(isTimeZone("Europe/Atlantis")).toBe(false);
    expect(isTimeZone("")).toBe(false);
  });
});

describe("automations in a project config", () => {
  it("accepts a whole definition", () => {
    const config = ProjectConfig.parse({
      automations: {
        "review-prs": {
          prompt: "List open PRs with gh and review the new ones.",
          trigger: { schedule: "every 1h", timeZone: "Europe/Rome" },
          budget: { wallClock: "30m", costUsd: 2 },
          model: "haiku",
          thinking: "low",
          enabled: true,
        },
        "run-by-hand": { prompt: "Tidy up." },
      },
    });
    expect(checkAutomations(config)).toMatchObject({ "review-prs": { model: "haiku" }, "run-by-hand": {} });
    expect(durationMs("30m")).toBe(1_800_000);
    expect(durationMs("2x")).toBeNull();
  });

  it("refuses hostile or broken definitions", () => {
    const one = (automation: unknown, name = "nightly") => ({ automations: { [name]: automation } });
    for (const [why, config] of [
      ["a name that is a path", one({ prompt: "x" }, "../escape")],
      ["a name with capitals", one({ prompt: "x" }, "Nightly")],
      ["a name too long", one({ prompt: "x" }, "a".repeat(41))],
      ["a permission mode", one({ prompt: "x", permissions: "bypassPermissions" })],
      ["a permission mode, nested", one({ prompt: "x", trigger: { schedule: "hourly", permissionMode: "auto" } })],
      ["an unknown key", one({ prompt: "x", cwd: "/" })],
      ["a prompt too long", one({ prompt: "x".repeat(8_001) })],
      ["a prompt that isn't text", one({ prompt: ["x"] })],
      ["a bad schedule", one({ prompt: "x", trigger: { schedule: "every 1s" } })],
      ["an unknown time zone", one({ prompt: "x", trigger: { schedule: "hourly", timeZone: "Mars/Olympus" } })],
      ["a wall clock too long", one({ prompt: "x", budget: { wallClock: "8d" } })],
      ["a wall clock too short", one({ prompt: "x", budget: { wallClock: "0m" } })],
      ["a negative cost", one({ prompt: "x", budget: { costUsd: -1 } })],
      ["a huge cost", one({ prompt: "x", budget: { costUsd: 1e9 } })],
      ["a cost over $20", one({ prompt: "x", budget: { costUsd: 20.01 } })],
      ["a wall clock over a day", one({ prompt: "x", budget: { wallClock: "25h" } })],
      ["a model that is a flag", one({ prompt: "x", model: "--dangerously-skip-permissions" })],
      ["too many", { automations: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`a${i}`, { prompt: "x" }])) }],
    ] as const) {
      expect(ProjectConfig.safeParse(config).success, why).toBe(false);
    }
    // A prototype key defines nothing (zod drops it), and pollutes nothing.
    const proto = ProjectConfig.parse(JSON.parse('{"automations":{"__proto__":{"prompt":"x"}}}'));
    expect(checkAutomations(proto)).toEqual({});
    expect(({} as Record<string, unknown>).prompt).toBeUndefined();
    // Whole once merged: a prompt is required.
    expect(checkAutomations(ProjectConfig.parse(one({ enabled: false })))).toMatch(/nightly\.prompt/);
    expect(checkAutomations(ProjectConfig.parse(one({ prompt: "   " })))).toMatch(/needs a prompt/);
  });
});
