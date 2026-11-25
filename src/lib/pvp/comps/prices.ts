import "server-only";
import { esi } from "@/lib/eve/esi";

/**
 * ESI's average price per type (/markets/prices), what the comps pipeline values losses at; one read
 * covers every type. Read once per run, uncached: the job runs once a day.
 */
export async function compPrices(signal?: AbortSignal): Promise<Map<number, number>> {
  const rows = await esi<{ type_id: number; average_price?: number }[]>("/markets/prices", { signal });
  const out = new Map<number, number>();
  for (const row of rows) if (row.average_price && row.average_price > 0) out.set(row.type_id, row.average_price);
  return out;
}
