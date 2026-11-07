import type { NextRequest } from "next/server";
import { runCronJob } from "@/lib/cron-jobs";
import { env } from "@/lib/env";

export const maxDuration = 300;

/**
 * Weekly crawl of the top PvP pilots' fits from zKillboard (schedule in vercel.json). Vercel Cron
 * calls it with `Authorization: Bearer $CRON_SECRET`. Each run is recorded for the health panel on
 * /admin; the job itself is in `src/lib/cron-jobs.ts`.
 */
export async function GET(request: NextRequest) {
  const secret = env().CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  return Response.json(await runCronJob("/api/cron/pvp-fits"));
}
