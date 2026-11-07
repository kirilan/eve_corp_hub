import "server-only";
import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/db";
import { type CronRun, cronRuns } from "@/db/schema";
import vercel from "../../vercel.json";

/** What each scheduled job is called on the health panel; the schedules themselves are in vercel.json. */
const JOB_NAMES: Record<string, string> = {
  "/api/cron/income": "Wallet sync",
  "/api/cron/pvp-fits": "Top PvP fits",
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

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

type Shape = { kind: "hourly"; minute: number } | { kind: "daily"; minute: number; hour: number } | { kind: "weekly"; minute: number; hour: number; day: number };

/** The three shapes this app uses, in UTC like Vercel Cron: hourly ("M * * * *"), daily ("M H * * *"), weekly ("M H * * D"). */
function shapeOf(schedule: string): Shape | null {
  const [minute, hour, dom, month, dow, ...extra] = schedule.trim().split(/\s+/);
  const m = field(minute ?? "");
  if (extra.length > 0 || dom !== "*" || month !== "*" || m === null || m > 59) return null;
  if (hour === "*") return dow === "*" ? { kind: "hourly", minute: m } : null;
  const h = field(hour ?? "");
  if (h === null || h > 23) return null;
  if (dow === "*") return { kind: "daily", minute: m, hour: h };
  const d = field(dow ?? "");
  return d === null || d > 7 ? null : { kind: "weekly", minute: m, hour: h, day: d % 7 };
}

/** When a schedule fires next, or null for a shape the panel does not understand (it then shows it raw). */
export function nextRun(schedule: string, now: Date): Date | null {
  const shape = shapeOf(schedule);
  if (!shape) return null;
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(shape.minute);
  if (shape.kind === "hourly") {
    if (next <= now) next.setUTCHours(next.getUTCHours() + 1);
    return next;
  }
  next.setUTCHours(shape.hour);
  if (shape.kind === "daily") {
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  next.setUTCDate(next.getUTCDate() + ((shape.day - next.getUTCDay() + 7) % 7));
  if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
  return next;
}

/** "Daily at 03:17 UTC", "Hourly at :05" or "Mondays at 04:41 UTC", or the raw schedule. */
export function describeSchedule(schedule: string): string {
  const shape = shapeOf(schedule);
  if (!shape) return schedule;
  const mm = String(shape.minute).padStart(2, "0");
  if (shape.kind === "hourly") return `Hourly at :${mm}`;
  const at = `${String(shape.hour).padStart(2, "0")}:${mm} UTC`;
  return shape.kind === "daily" ? `Daily at ${at}` : `${DAYS[shape.day]}s at ${at}`;
}

const HOUR_MS = 60 * 60 * 1000;

/** How long a schedule may go between runs before it counts as missed. */
function periodMs(schedule: string): number | null {
  const shape = shapeOf(schedule);
  if (!shape) return null;
  return { hourly: 1, daily: 24, weekly: 7 * 24 }[shape.kind] * HOUR_MS;
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
