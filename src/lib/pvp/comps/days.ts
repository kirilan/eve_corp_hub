/**
 * Which UTC days of zKillboard's dumps the fleet comps pipeline reads next. Pure, so it runs in tests
 * alike; the job that reads them is `sync.ts`.
 */

/** Bumped when what the pipeline keeps from a day changes: every day is then read again. */
export const COMPS_VERSION = 2;
/** The first day read: August to October 2026 seed the saved months, then it keeps going. */
export const FIRST_DAY = "2026-08-01";
/** Late killmails are picked up this far back: the 40 days side rows are kept. */
export const LATE_WINDOW_DAYS = 40;
/** Days read again for late killmails in one run, so a busy week of late mails cannot starve the rest. */
export const MAX_LATE_PER_RUN = 3;

// `reported`: the day's count in zKillboard's totals when it was read.
export type StoredDay = { day: string; reported: number | null; version: number };
export type PlannedDay = { day: string; reason: "new" | "version" | "late" };

/** "2026-11-25" plus `n` days, in UTC. */
export function addDays(day: string, n: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + n);
  return date.toISOString().slice(0, 10);
}

/** The UTC day of a moment, "YYYY-MM-DD". */
export const utcDay = (moment: Date) => moment.toISOString().slice(0, 10);

/**
 * The days to read, in order: first every day from FIRST_DAY to yesterday that was never read or was
 * read by an older version, oldest first; then up to MAX_LATE_PER_RUN days of the last LATE_WINDOW_DAYS
 * whose count in zKillboard's totals changed since they were read, newest first (late killmails land
 * mostly on recent days). Today is never read: its file is still growing.
 */
export function planDays(today: string, stored: Map<string, StoredDay>, totals: Map<string, number>): PlannedDay[] {
  const backlog: PlannedDay[] = [];
  const late: PlannedDay[] = [];
  const lateFrom = addDays(today, -LATE_WINDOW_DAYS);
  for (let day = FIRST_DAY; day < today; day = addDays(day, 1)) {
    const row = stored.get(day);
    if (!row) backlog.push({ day, reason: "new" });
    else if (row.version !== COMPS_VERSION) backlog.push({ day, reason: "version" });
    else if (day >= lateFrom && totals.has(day) && totals.get(day) !== row.reported) late.push({ day, reason: "late" });
  }
  return [...backlog, ...late.reverse().slice(0, MAX_LATE_PER_RUN)];
}
