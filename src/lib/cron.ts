import "server-only";
import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { type CronRun, cronRuns } from "@/db/schema";
import vercel from "../../vercel.json";

/** What each scheduled job is called on the health panel; the schedules themselves are in vercel.json. */
const JOB_NAMES: Record<string, string> = {
  "/api/cron/income": "Wallet sync",
};

// Runs are kept this long: plenty to spot a pattern, small enough never to matter.
const KEEP_DAYS = 90;
// Longer than any cron function may run (maxDuration 300 s): a run still open after this was killed.
const STUCK_MS = 10 * 60 * 1000;

/**
 * Runs a scheduled job and records it in `cron_runs`: a row when it starts, filled in when it ends.
 * Errors are recorded and rethrown, so the route still fails the way Vercel Cron expects.
 */
export async function recordCronRun<T extends Record<string, unknown>>(job: string, run: () => Promise<T>): Promise<T> {
  const [{ id }] = await db.insert(cronRuns).values({ job }).returning({ id: cronRuns.id });
  try {
    const result = await run();
    await db.update(cronRuns).set({ finishedAt: new Date(), ok: true, result }).where(eq(cronRuns.id, id));
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.update(cronRuns).set({ finishedAt: new Date(), ok: false, error: message }).where(eq(cronRuns.id, id));
    throw error;
  } finally {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 24 * 60 * 60 * 1000);
    await db.delete(cronRuns).where(and(eq(cronRuns.job, job), lt(cronRuns.startedAt, cutoff)));
  }
}

const field = (value: string) => (/^\d+$/.test(value) ? Number(value) : null);

/**
 * When a schedule fires next, for the two shapes this app uses: daily ("M H * * *") and hourly
 * ("M * * * *"), in UTC like Vercel Cron. Null for anything else; the panel then shows it raw.
 */
export function nextRun(schedule: string, now: Date): Date | null {
  const [minute, hour, ...rest] = schedule.trim().split(/\s+/);
  if (rest.length !== 3 || rest.some((part) => part !== "*") || field(minute) === null) return null;
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(field(minute)!);
  if (hour === "*") {
    if (next <= now) next.setUTCHours(next.getUTCHours() + 1);
    return next;
  }
  if (field(hour) === null) return null;
  next.setUTCHours(field(hour)!);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  return next;
}

/** "Daily at 03:17 UTC" or "Hourly at :05", or the raw schedule. */
export function describeSchedule(schedule: string): string {
  const [minute, hour] = schedule.trim().split(/\s+/);
  if (nextRun(schedule, new Date()) === null) return schedule;
  const mm = String(field(minute)).padStart(2, "0");
  return hour === "*" ? `Hourly at :${mm}` : `Daily at ${String(field(hour)).padStart(2, "0")}:${mm} UTC`;
}

/** How long a schedule may go between runs before it counts as missed. */
function periodMs(schedule: string): number | null {
  const [, hour] = schedule.trim().split(/\s+/);
  if (nextRun(schedule, new Date()) === null) return null;
  return (hour === "*" ? 1 : 24) * 60 * 60 * 1000;
}

export type RunState = "running" | "ok" | "failed" | "killed";

export function runState(run: Pick<CronRun, "ok" | "finishedAt" | "startedAt">, now: Date): RunState {
  if (run.ok === true) return "ok";
  if (run.ok === false) return "failed";
  return now.getTime() - run.startedAt.getTime() > STUCK_MS ? "killed" : "running";
}

export type CronJobStatus = {
  path: string;
  name: string;
  schedule: string;
  nextRun: Date | null;
  /** Newest first. */
  runs: CronRun[];
  lastSuccess: Date | null;
  /** True when the last run is older than one period plus an hour of slack: the scheduler did not call. */
  overdue: boolean;
};

/** Every job in vercel.json with its recent runs. */
export async function cronStatus(now = new Date(), recent = 10): Promise<CronJobStatus[]> {
  return Promise.all(
    vercel.crons.map(async ({ path, schedule }) => {
      const [runs, [success]] = await Promise.all([
        db.select().from(cronRuns).where(eq(cronRuns.job, path)).orderBy(desc(cronRuns.startedAt)).limit(recent),
        db
          .select({ at: cronRuns.startedAt })
          .from(cronRuns)
          .where(and(eq(cronRuns.job, path), eq(cronRuns.ok, true)))
          .orderBy(desc(cronRuns.startedAt))
          .limit(1),
      ]);
      const period = periodMs(schedule);
      const last = runs[0]?.startedAt;
      const overdue = period !== null && last !== undefined && now.getTime() - last.getTime() > period + 60 * 60 * 1000;
      return {
        path,
        name: JOB_NAMES[path] ?? path,
        schedule,
        nextRun: nextRun(schedule, now),
        runs,
        lastSuccess: success?.at ?? null,
        overdue,
      };
    }),
  );
}
