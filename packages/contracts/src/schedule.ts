/**
 * When an automation runs by itself (PRODUCT.md §7): a schedule as a person writes it, and the
 * next time it comes. Pure and framework-free, so the daemon schedules with it and a client can
 * show what a schedule means.
 *
 * Forms:
 * - `every 15m`, `every 2h`, `every 1d`: a fixed interval (at least 5 minutes, at most 30
 *   days), counted from when it last ran (or from when its schedule started). Time zones and
 *   daylight saving don't move it.
 * - `hourly`: `0 * * * *`. `daily 09:00`: every day at that time on the clock. `weekdays 09:00`:
 *   Monday to Friday.
 * - A cron line of five fields, `minute hour day-of-month month day-of-week`: numbers, `*`,
 *   ranges `a-b`, steps `*\/n` and `a-b/n`, lists `a,b`; day-of-week 0–7 (0 and 7 are Sunday).
 *   The two day fields combine as in Vixie cron (and cronie): when either one starts with `*`
 *   (`*`, `*\/2`) a day must match both; when neither does, a day matching either one is enough.
 *   The daemon starts scheduled runs at most every 5 minutes whatever the line says.
 *
 * Clock times are read in a time zone (IANA, e.g. `Europe/Rome`; default the machine's). A time
 * that doesn't exist on a spring-forward day runs as the clocks jump past it (02:30 runs at
 * 03:30), and a time that happens twice on a fall-back day runs once, the first time; this is
 * Temporal's "compatible" choice. So `hourly` skips the repeated hour on a fall-back night, a
 * two-hour gap: in Rome on 2026-10-25 it runs at 02:00 CEST (00:00Z), then at 03:00 CET
 * (02:00Z). `every 1h` doesn't.
 */

export type Schedule =
  | { kind: "every"; text: string; ms: number }
  | { kind: "cron"; text: string; cron: CronFields };

export interface CronFields {
  minutes: readonly number[];
  hours: readonly number[];
  days: ReadonlySet<number>;
  months: ReadonlySet<number>;
  weekdays: ReadonlySet<number>;
  /** Neither day field starts with `*` (Vixie cron): a day matches either; else both. */
  either: boolean;
}

/** The longest text a schedule may be. */
export const MAX_SCHEDULE_LENGTH = 100;

const MINUTE = 60_000;
/** The shortest interval between an automation's scheduled runs (the daemon holds cron to it). */
export const MIN_SCHEDULE_GAP_MS = 5 * MINUTE;
const DAY = 24 * 60 * MINUTE;
const UNITS: Record<string, number> = { m: MINUTE, h: 60 * MINUTE, d: DAY };
const MAX_EVERY = 30 * DAY;

/** A schedule as written → what it means, or what is wrong with it (a string). */
export function parseSchedule(input: string): Schedule | string {
  const text = input.trim().replaceAll(/\s+/g, " ");
  if (text === "") return "is empty";
  if (text.length > MAX_SCHEDULE_LENGTH) return `is longer than ${MAX_SCHEDULE_LENGTH} characters`;
  const every = /^every (\d{1,5}) ?(m|h|d)$/i.exec(text);
  if (every) {
    const ms = Number(every[1]) * (UNITS[every[2]!.toLowerCase()] ?? MINUTE);
    if (ms < MIN_SCHEDULE_GAP_MS) return "runs at most every 5 minutes (every 5m)";
    if (ms > MAX_EVERY) return "runs at least every 30 days (every 30d)";
    return { kind: "every", text, ms };
  }
  if (/^every\b/i.test(text)) return 'takes "every" with a number and m, h or d, like "every 15m" or "every 2h"';
  if (/^hourly$/i.test(text)) return cronSchedule(text, "0 * * * *");
  const clock = /^(daily|weekdays) (\d{1,2}):(\d{2})$/i.exec(text);
  if (clock) {
    const hour = Number(clock[2]);
    const minute = Number(clock[3]);
    if (hour > 23 || minute > 59) return `has no time ${clock[2]}:${clock[3]} (00:00 to 23:59)`;
    const days = clock[1]!.toLowerCase() === "daily" ? "*" : "1-5";
    return cronSchedule(text, `${minute} ${hour} * * ${days}`);
  }
  if (/^(daily|weekdays)\b/i.test(text)) return `takes a time on the clock, like "${text.split(" ")[0]} 09:00"`;
  return cronSchedule(text, text);
}

function cronSchedule(text: string, line: string): Schedule | string {
  const parts = line.split(" ");
  if (parts.length !== 5) {
    return 'isn\'t a schedule: use "every 1h", "hourly", "daily 09:00", "weekdays 09:00" or a cron line of five fields';
  }
  const [minute, hour, day, month, weekday] = parts as [string, string, string, string, string];
  const fields = [
    field(minute, 0, 59, "minute"),
    field(hour, 0, 23, "hour"),
    field(day, 1, 31, "day of the month"),
    field(month, 1, 12, "month"),
    field(weekday, 0, 7, "day of the week"),
  ] as const;
  for (const f of fields) if (typeof f === "string") return f;
  const [minutes, hours, days, months, weekdays] = fields as unknown as number[][];
  const cron: CronFields = {
    minutes: minutes!,
    hours: hours!,
    days: new Set(days),
    months: new Set(months),
    // 7 is Sunday too.
    weekdays: new Set(weekdays!.map((d) => d % 7)),
    // Vixie's DOM_STAR / DOW_STAR: a field that starts with `*` (`*/2` too) doesn't widen.
    either: !day.startsWith("*") && !weekday.startsWith("*"),
  };
  // A line that never comes (the 31st of February) is no schedule.
  if (nextCron(cron, "UTC", Date.UTC(2024, 0, 1)) === null) return "never comes (no such day)";
  return { kind: "cron", text, cron };
}

/** One cron field → its values, ascending, or what is wrong with it. */
function field(text: string, min: number, max: number, name: string): number[] | string {
  const values = new Set<number>();
  for (const part of text.split(",")) {
    const match = /^(\*|(\d{1,2})(?:-(\d{1,2}))?)(?:\/(\d{1,2}))?$/.exec(part);
    if (!match) return `has "${part}" as its ${name}, which cron doesn't read`;
    const step = match[4] === undefined ? 1 : Number(match[4]);
    let from = min;
    let to = max;
    if (match[1] !== "*") {
      from = Number(match[2]);
      to = match[3] === undefined ? (match[4] === undefined ? from : max) : Number(match[3]);
    }
    if (from < min || to > max || from > to) return `has ${part} as its ${name}, outside ${min}-${max}`;
    if (step < 1) return `has a step of 0 in its ${name}`;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

/**
 * When the schedule comes next after `after` (ms since the epoch), in time zone `timeZone`.
 * For `every`, `after` is when it last ran (or when its schedule started). Null only for a cron
 * line that doesn't come in the next eight years.
 */
export function nextRun(schedule: Schedule, timeZone: string, after: number): number | null {
  if (schedule.kind === "every") return after + schedule.ms;
  return nextCron(schedule.cron, timeZone, after);
}

/** How far ahead `nextCron` looks: eight years holds two leap days. */
const HORIZON_DAYS = 8 * 366;

function nextCron(cron: CronFields, timeZone: string, after: number): number | null {
  const start = wallOf(after, timeZone);
  for (let i = 0; i <= HORIZON_DAYS; i++) {
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + i));
    const year = date.getUTCFullYear();
    const month = date.getUTCMonth() + 1;
    const day = date.getUTCDate();
    if (!cron.months.has(month)) continue;
    const byDay = cron.days.has(day);
    const byWeekday = cron.weekdays.has(date.getUTCDay());
    if (cron.either ? !(byDay || byWeekday) : !(byDay && byWeekday)) continue;
    for (const hour of cron.hours) {
      // Earlier hours of the first day have passed (give or take a gap: checked below).
      if (i === 0 && hour < start.hour - 3) continue;
      for (const minute of cron.minutes) {
        const at = instantOf({ year, month, day, hour, minute }, timeZone);
        if (at > after) return at;
      }
    }
  }
  return null;
}

/** A time on the clock: year, month 1–12, day, hour 0–23, minute. */
export interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

const formats = new Map<string, Intl.DateTimeFormat>();

function formatFor(timeZone: string): Intl.DateTimeFormat {
  let format = formats.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formats.set(timeZone, format);
  }
  return format;
}

/** The clock in `timeZone` at `instant`, to the minute. */
export function wallOf(instant: number, timeZone: string): WallTime {
  const parts: Record<string, number> = {};
  for (const part of formatFor(timeZone).formatToParts(new Date(instant))) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year ?? 1970,
    month: parts.month ?? 1,
    day: parts.day ?? 1,
    hour: (parts.hour ?? 0) % 24,
    minute: parts.minute ?? 0,
  };
}

function wallMs(wall: WallTime): number {
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
}

/** How far `timeZone`'s clock is ahead of UTC at `instant`, in ms. */
function offsetAt(instant: number, timeZone: string): number {
  return wallMs(wallOf(instant, timeZone)) - (instant - (((instant % MINUTE) + MINUTE) % MINUTE));
}

/**
 * The instant `timeZone`'s clock shows `wall`. One the clock skips (spring forward) is moved
 * later by the gap; one it shows twice (fall back) is the first.
 */
export function instantOf(wall: WallTime, timeZone: string): number {
  const local = wallMs(wall);
  const before = local - offsetAt(local - DAY, timeZone);
  const after = local - offsetAt(local + DAY, timeZone);
  const shows = (instant: number) => wallMs(wallOf(instant, timeZone)) === local;
  const valid = [before, after].filter(shows);
  if (valid.length > 0) return Math.min(...valid);
  return before; // in the gap: as far past it as the clocks jumped
}

/** Whether `timeZone` is a time zone this machine knows (IANA, e.g. `Europe/Rome`, or UTC). */
export function isTimeZone(timeZone: string): boolean {
  if (timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    formatFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** The machine's own time zone. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}
