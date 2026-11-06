import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { marketHistory } from "@/db/schema";
import { esi, EsiError } from "@/lib/eve/esi";
import { HUBS, type Hub } from "./hubs";
import { type EsiHistoryDay, type Pace, paceFrom } from "./pace";

/**
 * How fast types trade in a hub's region, for the time-to-sell estimate, cached in `market_history`.
 * ESI publishes a region's history once a day at 11:05 UTC, so a type is read at most once a day.
 */

const FETCH_CONCURRENCY = 10;
// Stop asking once this many types fail: ESI is down, and its error limit is shared by the whole site.
const MAX_FAILURES = 5;
const ROLLOVER_UTC_MINUTES = 11 * 60 + 5;

/** The latest 11:05 UTC at or before `now`: history fetched before it may be a day behind. */
export function historyRollover(now: Date): Date {
  const day = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const today = day + ROLLOVER_UTC_MINUTES * 60 * 1000;
  return new Date(today <= now.getTime() ? today : today - 24 * 60 * 60 * 1000);
}

export type SalesPace = { pace: Map<number, Pace>; warnings: string[] };

/** Recent trading of these types in the hub's region, reading ESI for the ones not read since the last rollover. */
export async function salesPace(hub: Hub, typeIds: number[], signal: AbortSignal): Promise<SalesPace> {
  const { regionId, regionName } = HUBS[hub];
  const wanted = [...new Set(typeIds)];
  if (wanted.length === 0) return { pace: new Map(), warnings: [] };
  const rows = await db
    .select()
    .from(marketHistory)
    .where(and(eq(marketHistory.regionId, regionId), inArray(marketHistory.typeId, wanted)));
  const known = new Map(rows.map((row) => [row.typeId, row]));
  const now = new Date();
  const rollover = historyRollover(now).getTime();
  const stale = wanted.filter((typeId) => (known.get(typeId)?.fetchedAt.getTime() ?? 0) < rollover);

  let failures = 0;
  const fresh: (typeof marketHistory.$inferInsert)[] = [];
  for (let i = 0; i < stale.length; i += FETCH_CONCURRENCY) {
    await Promise.all(
      stale.slice(i, i + FETCH_CONCURRENCY).map(async (typeId) => {
        if (failures >= MAX_FAILURES || signal.aborted) return;
        try {
          const days = await esi<EsiHistoryDay[]>(`/markets/${regionId}/history?type_id=${typeId}`, { signal });
          if (!Array.isArray(days)) throw new Error("market history is not a list");
          fresh.push({ regionId, typeId, ...paceFrom(days, now), fetchedAt: now });
        } catch (error) {
          // A type the market does not know has no history, and asking again tomorrow will not change that.
          if (error instanceof EsiError && error.status === 404) {
            fresh.push({ regionId, typeId, volume: 0, average: null, fetchedAt: now });
            return;
          }
          failures++;
          console.warn(`market history read failed for type ${typeId} in ${regionName}`, error);
        }
      }),
    );
  }
  if (fresh.length > 0) {
    await db
      .insert(marketHistory)
      .values(fresh)
      .onConflictDoUpdate({
        target: [marketHistory.regionId, marketHistory.typeId],
        set: { volume: sql`excluded.volume`, average: sql`excluded.average`, fetchedAt: sql`excluded.fetched_at` },
      });
    for (const row of fresh) known.set(row.typeId, { ...row, average: row.average ?? null, fetchedAt: now });
  }

  const missed = stale.length - fresh.length;
  const absent = wanted.filter((typeId) => !known.has(typeId)).length;
  const warnings =
    missed > 0
      ? [
          `EVE's market history did not answer for ${missed} item${missed === 1 ? "" : "s"}` +
            (absent > 0 ? `; ${absent} have no time-to-sell estimate` : "; older history is used for them") +
            ".",
        ]
      : [];
  return { pace: new Map([...known].map(([typeId, row]) => [typeId, { volume: row.volume, average: row.average }])), warnings };
}
