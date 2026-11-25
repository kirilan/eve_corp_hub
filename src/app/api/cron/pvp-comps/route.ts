import type { NextRequest } from "next/server";
import { runCronJob } from "@/lib/cron-jobs";
import { env } from "@/lib/env";

export const maxDuration = 300;

/**
 * Daily read of zKillboard's bulk killmail dumps for the fleet comps pipeline (schedule in vercel.json),
 * after zKillboard rebuilds them around 06:20 UTC. Vercel Cron calls it with
 * `Authorization: Bearer $CRON_SECRET`. Each run is recorded for the health panel on /admin; the job
 * itself is in `src/lib/cron-jobs.ts`.
 */
export async function GET(request: NextRequest) {
  const secret = env().CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  return Response.json(await runCronJob("/api/cron/pvp-comps"));
}
