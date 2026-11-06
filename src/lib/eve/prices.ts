import "server-only";
import { cacheLife } from "next/cache";
import { esi } from "./esi";

/**
 * EVE's own estimate of what each type is worth (`average_price` of /markets/prices), for valuing
 * stock that has not sold yet. One read covers every type; ESI refreshes it about hourly. An ESI
 * failure yields no prices rather than an error page.
 */
export async function averagePrices(): Promise<Record<number, number>> {
  try {
    return await cachedAveragePrices();
  } catch (error) {
    console.warn("average price lookup failed", error);
    return {};
  }
}

async function cachedAveragePrices(): Promise<Record<number, number>> {
  "use cache";
  cacheLife("hours");
  const rows = await esi<{ type_id: number; average_price?: number }[]>("/markets/prices");
  const out: Record<number, number> = {};
  for (const row of rows) if (row.average_price && row.average_price > 0) out[row.type_id] = row.average_price;
  return out;
}
