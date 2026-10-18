import type { NextRequest } from "next/server";
import { recordCronRun } from "@/lib/cron";
import { env } from "@/lib/env";
import { syncAllIncome } from "@/lib/income/sync";

export const maxDuration = 300;

/**
 * Daily wallet sync for every character that allows wallet tracking (schedule in vercel.json).
 * ESI keeps only 30 days of journal, so this is what keeps history complete for owners who do
 * not open the tracker for a while. Vercel Cron calls it with `Authorization: Bearer $CRON_SECRET`.
 * Each run is recorded for the health panel on /admin.
 */
export async function GET(request: NextRequest) {
  const secret = env().CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  // Leaves a minute of the function's budget for the syncs already in flight to finish.
  const result = await recordCronRun("/api/cron/income", () => syncAllIncome((maxDuration - 60) * 1000));
  return Response.json(result);
}
