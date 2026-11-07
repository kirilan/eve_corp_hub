import { revalidateTag } from "next/cache";
import type { NextRequest } from "next/server";
import { recordCronRun } from "@/lib/cron";
import { env } from "@/lib/env";
import { crawlPvpFits } from "@/lib/pvp/crawl";
import { PVP_FITS_TAG } from "@/lib/pvp/fits";

export const maxDuration = 300;

/**
 * Weekly crawl of the top PvP pilots' fits from zKillboard (schedule in vercel.json). Vercel Cron
 * calls it with `Authorization: Bearer $CRON_SECRET`; each run is recorded for the health panel.
 */
export async function GET(request: NextRequest) {
  const secret = env().CRON_SECRET;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("unauthorized", { status: 401 });
  }
  const result = await recordCronRun("/api/cron/pvp-fits", () => crawlPvpFits(AbortSignal.timeout((maxDuration - 30) * 1000)));
  // The next visit reads the new list rather than last week's.
  revalidateTag(PVP_FITS_TAG, { expire: 0 });
  return Response.json(result);
}
