/**
 * Schedule expressions and the ONE next-fire computation.
 *
 * Both the ticker (which decides when to fire) and the API (which reports
 * `nextFireAt` to the Console) call `nextFire()` here. The browser never
 * recomputes a next-fire time, so a displayed time cannot disagree with the
 * time the scheduler actually acts on.
 *
 * Two expression kinds, deliberately:
 *
 *   cron:<minute> <hour> <day-of-month> <month> <day-of-week>
 *       Standard five-field cron evaluated against the WALL CLOCK of the
 *       schedule's IANA time zone. Fields accept `*`, `n`, `a-b`, step forms
 *       (a step is written after a slash, as in every-third-minute), and comma
 *       lists. Day-of-week is 0-6 with 0 = Sunday (7 also
 *       accepted as Sunday). Vixie semantics for the day pair: when BOTH
 *       day-of-month and day-of-week are restricted, a day matches if EITHER
 *       matches; when only one is restricted, only that one is consulted.
 *
 *   every:<n>s | every:<n>m | every:<n>h
 *       A fixed interval on the absolute time line, aligned to the Unix epoch,
 *       so window boundaries are identical in every process and after every
 *       restart. Cron cannot express sub-minute periods; this can, which is
 *       what makes an observed unattended fire practical to demonstrate.
 *
 * WINDOW KEYS — the identity of a firing opportunity, and the whole of the
 * idempotency story (see docs/adr/F13-scheduling.md):
 *
 *   every:  the aligned window's UTC instant, e.g. `1786000020000`
 *   cron:   the LOCAL WALL MINUTE, e.g. `2026-11-01T01:30`
 *
 * The cron choice is what answers DST without a special case. On the autumn
 * fall-back the repeated 01:30 is ONE key, so the second occurrence collapses
 * into the first and fires once. In the spring-forward gap the wall time never
 * exists, so no instant carries that key and the day is skipped.
 */
import {
  instantsForWallClock,
  nextCalendarDay,
  wallClockKey,
  weekdayOfCalendarDay,
  zonedWallClock,
} from "./timezone.ts";

export class ScheduleExpressionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleExpressionError";
  }
}

export interface CronExpression {
  kind: "cron";
  source: string;
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

export interface IntervalExpression {
  kind: "every";
  source: string;
  intervalMs: number;
}

export type ScheduleExpression = CronExpression | IntervalExpression;

export interface NextFire {
  /** Absolute instant at which this window becomes due. */
  instantMs: number;
  /** Stable identity of the window; the requestId is built from it. */
  windowKey: string;
}

/** The furthest ahead `nextFire` will search before reporting "never". */
export const NEXT_FIRE_HORIZON_DAYS = 366;

const MINIMUM_INTERVAL_MS = 1_000;
const MAXIMUM_INTERVAL_MS = 365 * 86_400_000;

function parseField(
  field: string,
  minimum: number,
  maximum: number,
  label: string,
  normalise?: (value: number) => number,
): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  let restricted = false;
  for (const term of field.split(",")) {
    if (term.length === 0) {
      throw new ScheduleExpressionError(`The ${label} field has an empty term.`);
    }
    const [rangePart, stepPart, ...extra] = term.split("/");
    if (extra.length > 0) {
      throw new ScheduleExpressionError(`The ${label} field has more than one step.`);
    }
    let step = 1;
    if (stepPart !== undefined) {
      if (!/^\d+$/.test(stepPart)) {
        throw new ScheduleExpressionError(`The ${label} step must be a whole number.`);
      }
      step = Number(stepPart);
      if (step < 1) throw new ScheduleExpressionError(`The ${label} step must be at least 1.`);
      restricted = true;
    }
    let first = minimum;
    let last = maximum;
    if (rangePart !== "*") {
      restricted = true;
      const bounds = rangePart.split("-");
      if (bounds.length > 2 || bounds.some((bound) => !/^\d+$/.test(bound))) {
        throw new ScheduleExpressionError(`The ${label} field has an unreadable term "${term}".`);
      }
      first = Number(bounds[0]);
      last = bounds.length === 2 ? Number(bounds[1]) : first;
    }
    if (first < minimum || last > maximum || first > last) {
      throw new ScheduleExpressionError(
        `The ${label} field must stay within ${minimum}-${maximum}.`,
      );
    }
    for (let value = first; value <= last; value += step) {
      values.add(normalise ? normalise(value) : value);
    }
  }
  if (values.size === 0) {
    throw new ScheduleExpressionError(`The ${label} field matches nothing.`);
  }
  return { values, restricted };
}

function parseCron(body: string): CronExpression {
  const fields = body.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ScheduleExpressionError(
      "A cron expression needs exactly five fields: minute hour day-of-month month day-of-week.",
    );
  }
  const minute = parseField(fields[0], 0, 59, "minute");
  const hour = parseField(fields[1], 0, 23, "hour");
  const dayOfMonth = parseField(fields[2], 1, 31, "day-of-month");
  const month = parseField(fields[3], 1, 12, "month");
  // 7 is a second spelling of Sunday in every cron dialect that accepts it.
  const dayOfWeek = parseField(fields[4], 0, 7, "day-of-week", (value) => value % 7);
  return {
    kind: "cron",
    source: `cron:${fields.join(" ")}`,
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dayOfMonth.values,
    months: month.values,
    daysOfWeek: dayOfWeek.values,
    dayOfMonthRestricted: dayOfMonth.restricted,
    dayOfWeekRestricted: dayOfWeek.restricted,
  };
}

function parseInterval(body: string): IntervalExpression {
  const match = /^(\d+)(s|m|h)$/.exec(body.trim());
  if (!match) {
    throw new ScheduleExpressionError(
      'An interval expression looks like "every:30s", "every:5m" or "every:2h".',
    );
  }
  const unitMs = { s: 1_000, m: 60_000, h: 3_600_000 }[match[2] as "s" | "m" | "h"];
  const intervalMs = Number(match[1]) * unitMs;
  if (intervalMs < MINIMUM_INTERVAL_MS) {
    throw new ScheduleExpressionError("An interval schedule must be at least 1 second.");
  }
  if (intervalMs > MAXIMUM_INTERVAL_MS) {
    throw new ScheduleExpressionError("An interval schedule must be at most 365 days.");
  }
  return { kind: "every", source: `every:${match[1]}${match[2]}`, intervalMs };
}

/** Parse an expression, or throw `ScheduleExpressionError` with a path-free reason. */
export function parseScheduleExpression(expression: string): ScheduleExpression {
  if (typeof expression !== "string" || expression.length === 0 || expression.length > 128) {
    throw new ScheduleExpressionError(
      'A schedule expression is required, e.g. "cron:0 9 * * 1-5" or "every:30s".',
    );
  }
  const separator = expression.indexOf(":");
  if (separator === -1) {
    throw new ScheduleExpressionError(
      'A schedule expression must start with "cron:" or "every:".',
    );
  }
  const prefix = expression.slice(0, separator);
  const body = expression.slice(separator + 1);
  if (prefix === "cron") return parseCron(body);
  if (prefix === "every") return parseInterval(body);
  throw new ScheduleExpressionError(
    `Unknown schedule kind "${prefix}". Use "cron:" or "every:".`,
  );
}

function cronDayMatches(expression: CronExpression, date: {
  year: number;
  month: number;
  day: number;
}): boolean {
  if (!expression.months.has(date.month)) return false;
  const dayOfMonthMatches = expression.daysOfMonth.has(date.day);
  const dayOfWeekMatches = expression.daysOfWeek.has(weekdayOfCalendarDay(date));
  if (expression.dayOfMonthRestricted && expression.dayOfWeekRestricted) {
    return dayOfMonthMatches || dayOfWeekMatches;
  }
  if (expression.dayOfMonthRestricted) return dayOfMonthMatches;
  if (expression.dayOfWeekRestricted) return dayOfWeekMatches;
  return true;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function nextCronFire(
  expression: CronExpression,
  timeZone: string,
  afterMs: number,
): NextFire | null {
  const sortedHours = [...expression.hours].sort((left, right) => left - right);
  const sortedMinutes = [...expression.minutes].sort((left, right) => left - right);
  const start = zonedWallClock(afterMs, timeZone);
  let date = { year: start.year, month: start.month, day: start.day };
  for (let dayIndex = 0; dayIndex <= NEXT_FIRE_HORIZON_DAYS; dayIndex += 1) {
    if (date.day <= daysInMonth(date.year, date.month) && cronDayMatches(expression, date)) {
      for (const hour of sortedHours) {
        for (const minute of sortedMinutes) {
          const wall = { ...date, hour, minute };
          // A wall minute with no instant is the spring-forward gap: it is
          // skipped, deliberately, and the skip is visible because nextFire
          // simply moves on to the next matching minute.
          for (const instantMs of instantsForWallClock(wall, timeZone)) {
            if (instantMs > afterMs) {
              return { instantMs, windowKey: wallClockKey(wall) };
            }
          }
        }
      }
    }
    date = nextCalendarDay(date);
  }
  return null;
}

function nextIntervalFire(expression: IntervalExpression, afterMs: number): NextFire {
  const instantMs = (Math.floor(afterMs / expression.intervalMs) + 1) * expression.intervalMs;
  return { instantMs, windowKey: String(instantMs) };
}

/**
 * The first firing opportunity STRICTLY after `afterMs`, or null when the
 * expression has no match inside the search horizon (e.g. `cron:0 0 30 2 *` —
 * 30 February, which is never). A null next-fire is reported honestly by the
 * API and rendered as "never" by the Console rather than as a blank.
 */
export function nextFire(
  expression: ScheduleExpression,
  timeZone: string,
  afterMs: number,
): NextFire | null {
  return expression.kind === "every"
    ? nextIntervalFire(expression, afterMs)
    : nextCronFire(expression, timeZone, afterMs);
}

/**
 * Every window between `afterMs` (exclusive) and `untilMs` (inclusive), oldest
 * first, capped at `limit`. Used by the restart catch-up pass to see what was
 * missed while the process was down. `truncated` is true when the cap hid
 * windows, so the caller can record the omission instead of hiding it.
 */
export function windowsBetween(
  expression: ScheduleExpression,
  timeZone: string,
  afterMs: number,
  untilMs: number,
  limit: number,
): { windows: NextFire[]; truncated: boolean } {
  const windows: NextFire[] = [];
  let cursor = afterMs;
  for (;;) {
    const candidate = nextFire(expression, timeZone, cursor);
    if (!candidate || candidate.instantMs > untilMs) return { windows, truncated: false };
    if (windows.length === limit) return { windows, truncated: true };
    windows.push(candidate);
    cursor = candidate.instantMs;
  }
}
