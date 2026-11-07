import "server-only";
import { desc, eq } from "drizzle-orm";
import { revalidateTag } from "next/cache";
import { db } from "@/db";
import { cronRuns } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { Viewer } from "@/lib/auth/accounts";
import { jobName, recordCronRun, runState } from "@/lib/cron";
import { syncAllIncome } from "@/lib/income/sync";
import { canRunCronJobs } from "@/lib/permissions";
import { crawlPvpFits } from "@/lib/pvp/crawl";
import { PVP_FITS_TAG } from "@/lib/pvp/fits";

/**
 * What each scheduled job does, for both callers: Vercel Cron (the routes under /api/cron) and a super
 * user's "Run now" on the health panel. Schedules are in vercel.json, names in cron.ts.
 */

// Both callers run inside a 300-second function (the routes' and /admin's maxDuration); a minute is
// left for work in flight to finish and the run to be recorded.
export const JOB_BUDGET_MS = 240_000;

const JOBS: Record<string, (budgetMs: number) => Promise<Record<string, unknown>>> = {
  "/api/cron/income": (budgetMs) => syncAllIncome(budgetMs),
  "/api/cron/pvp-fits": async (budgetMs) => {
    const result = await crawlPvpFits(AbortSignal.timeout(budgetMs));
    // The next visit reads the new week rather than the cached list.
    revalidateTag(PVP_FITS_TAG, { expire: 0 });
    return result;
  },
};

export class CronJobError extends Error {}

/** Runs a job and records the run for the health panel. */
export function runCronJob(path: string, budgetMs = JOB_BUDGET_MS) {
  const job = JOBS[path];
  if (!job) throw new CronJobError(`No job at ${path}.`);
  return recordCronRun(path, () => job(budgetMs));
}

/**
 * A super user's "Run now": the same run as the schedule's, recorded the same way, and in the audit
 * log under who asked. Refused while the job's last run is still going.
 */
export async function runCronJobNow(viewer: Viewer, path: string) {
  if (!canRunCronJobs(viewer)) throw new CronJobError("Only super users run scheduled jobs.");
  if (!JOBS[path]) throw new CronJobError(`No job at ${path}.`);
  const [last] = await db.select().from(cronRuns).where(eq(cronRuns.job, path)).orderBy(desc(cronRuns.startedAt)).limit(1);
  if (last && runState(last, new Date()) === "running") throw new CronJobError(`${jobName(path)} is already running.`);
  await db.transaction((tx) =>
    audit(tx, viewer, { action: "cron.run", subjectType: "cron", subjectId: path, subjectName: jobName(path), corporationId: null }),
  );
  return runCronJob(path);
}
