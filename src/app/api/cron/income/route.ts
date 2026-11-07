import type { NextRequest } from "next/server";
import { runCronJob } from "@/lib/cron-jobs";
import { env } from "@/lib/env";

export const maxDuration = 300;

/**
 * Daily wallet sync for every character that allows wallet tracking (schedule in vercel.json).
 * ESI keeps only 30 days of journal, so this is what keeps history complete for owners who do
 * not open the tracker for a while. Vercel Cron calls it with `Authorization: Bearer $CRON_SECRET`.
 * Each run is recorded for the health panel on /admin; the job itself is in `src/lib/cron-jobs.ts`.
 */
export async function GET(request: NextRequest) {
  const secret = env().CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  return Response.json(await runCronJob("/api/cron/income"));
}
