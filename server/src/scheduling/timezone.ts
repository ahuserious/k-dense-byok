/**
 * IANA-timezone conversion for the schedule ticker, built ONLY on
 * `Intl.DateTimeFormat` with the `timeZone` option. No dependency is added and
 * no offset arithmetic is hand-rolled: every offset in this module is measured
 * by asking Intl what the wall clock reads at a known instant, which is the one
 * question the platform database can answer authoritatively across DST rules.
 *
 * Two directions are needed:
 *   instant → wall clock   (`zonedWallClock`)   — trivial, one formatToParts.
 *   wall clock → instant   (`instantsForWallClock`) — NOT a function. A local
 *     wall time can map to zero instants (the spring-forward gap: 02:30 does
 *     not exist on the day the clocks jump 02:00 → 03:00) or to two (the autumn
 *     fall-back repeat: 01:30 happens twice). The return type is therefore a
 *     list, ordered earliest-first, and callers state their own policy on it.
 *     The scheduler's policy lives in expression.ts / scheduler.ts, not here.
 */

export interface ZonedWallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday, matching cron's day-of-week numbering. */
  weekday: number;
}

const WEEKDAY_INDEX = new Map([
  ["Sun", 0],
  ["Mon", 1],
  ["Tue", 2],
  ["Wed", 3],
  ["Thu", 4],
  ["Fri", 5],
  ["Sat", 6],
]);

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  const cached = formatterCache.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

/**
 * True when the runtime's ICU data recognises `timeZone`. Used by the API to
 * reject a bad timezone at write time rather than at fire time — a schedule
 * that cannot compute a next-fire time must never be persisted.
 */
export function isSupportedTimeZone(timeZone: string): boolean {
  if (typeof timeZone !== "string" || timeZone.length === 0 || timeZone.length > 64) return false;
  try {
    formatterFor(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** What the wall clock in `timeZone` reads at the given absolute instant. */
export function zonedWallClock(instantMs: number, timeZone: string): ZonedWallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(instantMs));
  const field = (type: Intl.DateTimeFormatPartTypes): string => {
    const found = parts.find((part) => part.type === type);
    if (!found) throw new Error(`Intl did not report ${type} for time zone ${timeZone}.`);
    return found.value;
  };
  const weekday = WEEKDAY_INDEX.get(field("weekday"));
  if (weekday === undefined) {
    throw new Error(`Intl reported an unrecognised weekday for time zone ${timeZone}.`);
  }
  return {
    year: Number(field("year")),
    month: Number(field("month")),
    day: Number(field("day")),
    hour: Number(field("hour")),
    minute: Number(field("minute")),
    second: Number(field("second")),
    weekday,
  };
}

/**
 * The zone's offset from UTC at `instantMs`, in milliseconds
 * (wall clock minus UTC). Positive east of Greenwich.
 */
function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const wall = zonedWallClock(instantMs, timeZone);
  const asUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second);
  // Intl reports whole seconds; compare against the instant floored to the same
  // resolution so a sub-second remainder cannot leak into the offset.
  const instantFlooredToSecond = Math.floor(instantMs / 1_000) * 1_000;
  return asUtc - instantFlooredToSecond;
}

const DAY_MS = 86_400_000;

/**
 * Every absolute instant at which the wall clock in `timeZone` reads exactly
 * the given local date and time, earliest first.
 *
 *   - length 0 → that wall time does not exist (spring-forward gap).
 *   - length 1 → the ordinary case.
 *   - length 2 → that wall time happens twice (autumn fall-back repeat).
 *
 * Method: the only two offsets that can possibly apply to a wall time are the
 * ones in force a day before and a day after it (a transition moves the clock
 * by at most a couple of hours, so a ±24 h window brackets both sides of any
 * real-world rule). Each candidate instant is verified by formatting it back;
 * only exact round-trips are returned, which is what makes the gap detectable
 * instead of silently snapping to a neighbouring time.
 */
export function instantsForWallClock(
  wall: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): number[] {
  const naiveUtc = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, 0, 0);
  const offsets = new Set<number>([
    zoneOffsetMs(naiveUtc - DAY_MS, timeZone),
    zoneOffsetMs(naiveUtc + DAY_MS, timeZone),
  ]);
  const found: number[] = [];
  for (const offset of offsets) {
    const candidate = naiveUtc - offset;
    const roundTrip = zonedWallClock(candidate, timeZone);
    if (
      roundTrip.year === wall.year &&
      roundTrip.month === wall.month &&
      roundTrip.day === wall.day &&
      roundTrip.hour === wall.hour &&
      roundTrip.minute === wall.minute &&
      !found.includes(candidate)
    ) {
      found.push(candidate);
    }
  }
  return found.sort((left, right) => left - right);
}

/** Advance a local calendar date by one day, ignoring clocks entirely. */
export function nextCalendarDay(date: { year: number; month: number; day: number }): {
  year: number;
  month: number;
  day: number;
} {
  const stepped = new Date(Date.UTC(date.year, date.month - 1, date.day) + DAY_MS);
  return {
    year: stepped.getUTCFullYear(),
    month: stepped.getUTCMonth() + 1,
    day: stepped.getUTCDate(),
  };
}

/** Day of week (0 = Sunday) for a local calendar date. */
export function weekdayOfCalendarDay(date: {
  year: number;
  month: number;
  day: number;
}): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** `2026-11-01T01:30` — the stable, human-readable identity of a wall minute. */
export function wallClockKey(wall: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}): string {
  const pad = (value: number, width: number) => String(value).padStart(width, "0");
  return `${pad(wall.year, 4)}-${pad(wall.month, 2)}-${pad(wall.day, 2)}T${pad(wall.hour, 2)}:${pad(wall.minute, 2)}`;
}
