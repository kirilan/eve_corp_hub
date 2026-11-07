import "server-only";
import { and, asc, countDistinct, desc, eq, gte, ilike, lte, or, sql, type SQL } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { db } from "@/db";
import { eveTypes, pvpCrawls, pvpFits, pvpPilots, pvpShipKills } from "@/db/schema";
import type { Viewer } from "@/lib/auth/accounts";
import { FittingError, saveCopy, writeToGame, type Contents } from "@/lib/fittings/store";
import type { PvpFilter } from "./filter";

/**
 * The top PvP pilots' fits, one set per crawled week, every week kept. Public game data: everyone may
 * read them, signed in or not, and a signed-in viewer may copy one into their own fits or send it to
 * their own characters. Cached until the next crawl invalidates `PVP_FITS_TAG`.
 */

export const PVP_FITS_TAG = "pvp-fits";

export function zkillKillUrl(killmailId: number) {
  return `https://zkillboard.com/kill/${killmailId}/`;
}

export function zkillCharacterUrl(characterId: number) {
  return `https://zkillboard.com/character/${characterId}/`;
}

/** Every crawled week, newest first, with how many fits it has and how many pilots lost them. */
export async function pvpWeeks() {
  "use cache";
  cacheTag(PVP_FITS_TAG);
  cacheLife("days");
  const rows = await db
    .select({ id: pvpCrawls.id, crawledAt: pvpCrawls.crawledAt, fits: countDistinct(pvpFits.killmailId), pilots: countDistinct(pvpFits.characterId) })
    .from(pvpCrawls)
    .leftJoin(pvpFits, eq(pvpFits.crawlId, pvpCrawls.id))
    .groupBy(pvpCrawls.id)
    .orderBy(desc(pvpCrawls.crawledAt));
  return rows.map((row) => ({ id: row.id, crawledAt: row.crawledAt.toISOString(), fits: row.fits, pilots: row.pilots }));
}

export type PvpWeek = Awaited<ReturnType<typeof pvpWeeks>>[number];

const fitSummary = {
  crawlId: pvpFits.crawlId,
  killmailId: pvpFits.killmailId,
  characterId: pvpFits.characterId,
  shipTypeId: pvpFits.shipTypeId,
  shipName: eveTypes.name,
  losses: pvpFits.losses,
  lostAt: pvpFits.lostAt,
  value: pvpFits.value,
  kills: pvpShipKills.kills,
  iskDestroyed: pvpShipKills.iskDestroyed,
};

/** What the fit's pilot killed that week in the fit's hull (nothing for weeks crawled before kills were). */
const hullKills = and(
  eq(pvpShipKills.crawlId, pvpFits.crawlId),
  eq(pvpShipKills.characterId, pvpFits.characterId),
  eq(pvpShipKills.shipTypeId, pvpFits.shipTypeId),
);
// Within a pilot: the hulls they killed most with first, then the most-lost loadouts, then the newest.
const fitOrder = [sql`${pvpShipKills.kills} desc nulls last`, desc(pvpFits.losses), desc(pvpFits.lostAt)];

type FitSummary = {
  crawlId: number;
  killmailId: number;
  characterId: number;
  shipTypeId: number;
  shipName: string | null;
  losses: number;
  lostAt: Date;
  value: number | null;
  kills: number | null;
  iskDestroyed: number | null;
};
type HullKills = { crawlId: number; characterId: number; shipTypeId: number; shipName: string | null; kills: number; iskDestroyed: number };

/**
 * Pilots in the given order, each with their fits (already in display order) and the hulls they killed
 * with but lost no fit in (`otherShips`, most kills first), dates as ISO strings.
 */
function withFits(pilots: (typeof pvpPilots.$inferSelect)[], fits: FitSummary[], hulls: HullKills[] = []) {
  return pilots.map((pilot) => ({
    characterId: pilot.characterId,
    rank: pilot.rank,
    name: pilot.name,
    corporationId: pilot.corporationId,
    allianceId: pilot.allianceId,
    losses: pilot.losses,
    fits: fits
      .filter((fit) => fit.crawlId === pilot.crawlId && fit.characterId === pilot.characterId)
      .map((fit) => ({
        killmailId: fit.killmailId,
        characterId: fit.characterId,
        shipTypeId: fit.shipTypeId,
        shipName: fit.shipName,
        losses: fit.losses,
        lostAt: fit.lostAt.toISOString(),
        value: fit.value,
        kills: fit.kills,
        iskDestroyed: fit.iskDestroyed,
      })),
    otherShips: hulls
      .filter((hull) => hull.crawlId === pilot.crawlId && hull.characterId === pilot.characterId)
      .filter((hull) => !fits.some((fit) => fit.crawlId === hull.crawlId && fit.characterId === hull.characterId && fit.shipTypeId === hull.shipTypeId))
      .map(({ shipTypeId, shipName, kills, iskDestroyed }) => ({ shipTypeId, shipName, kills, iskDestroyed })),
  }));
}

/**
 * One week's pilots in rank order, each with their fits (hulls they killed most with first) and the
 * other hulls they killed with: the week with id `crawlId`,
 * or the latest when it is not given. `crawl` is null when there is no such week. Dates are ISO
 * strings (cached values are serialized).
 */
export async function topPvpPilots(crawlId?: number) {
  "use cache";
  cacheTag(PVP_FITS_TAG);
  cacheLife("days");
  const [crawl] = await db
    .select()
    .from(pvpCrawls)
    .where(crawlId === undefined ? undefined : eq(pvpCrawls.id, crawlId))
    .orderBy(desc(pvpCrawls.crawledAt))
    .limit(1);
  if (!crawl) return { crawl: null, pilots: [] };
  const [pilots, fits, hulls] = await Promise.all([
    db.select().from(pvpPilots).where(eq(pvpPilots.crawlId, crawl.id)).orderBy(asc(pvpPilots.rank)),
    db
      .select(fitSummary)
      .from(pvpFits)
      .leftJoin(eveTypes, eq(eveTypes.id, pvpFits.shipTypeId))
      .leftJoin(pvpShipKills, hullKills)
      .where(eq(pvpFits.crawlId, crawl.id))
      .orderBy(...fitOrder),
    db
      .select({
        crawlId: pvpShipKills.crawlId,
        characterId: pvpShipKills.characterId,
        shipTypeId: pvpShipKills.shipTypeId,
        shipName: eveTypes.name,
        kills: pvpShipKills.kills,
        iskDestroyed: pvpShipKills.iskDestroyed,
      })
      .from(pvpShipKills)
      .leftJoin(eveTypes, eq(eveTypes.id, pvpShipKills.shipTypeId))
      .where(eq(pvpShipKills.crawlId, crawl.id))
      .orderBy(desc(pvpShipKills.kills)),
  ]);
  return { crawl: { id: crawl.id, crawledAt: crawl.crawledAt.toISOString() }, pilots: withFits(pilots, fits, hulls) };
}

export type TopPvpPilot = Awaited<ReturnType<typeof topPvpPilots>>["pilots"][number];

/** Most fits a search returns; past it the result says it was cut short. */
export const SEARCH_LIMIT = 200;

/**
 * Fits from every week that match `filter`: the ship's name, the pilot's name or the fit's name contains
 * `q` (any case), zKillboard's value of the loss is within `minValue`..`maxValue` (a fit with no
 * value never passes an ISK bound), and its pilot was on at least `minKills` kills in that hull that
 * week (weeks crawled before kills were never pass it). Grouped by week, newest first, then by pilot in rank order, only
 * pilots with a match. Not cached: queries are open-ended.
 */
export async function searchPvpFits(filter: PvpFilter) {
  const conditions: SQL[] = [];
  if (filter.q) {
    const pattern = `%${filter.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(or(ilike(eveTypes.name, pattern), ilike(pvpPilots.name, pattern), ilike(pvpFits.name, pattern))!);
  }
  if (filter.minValue !== undefined) conditions.push(gte(pvpFits.value, filter.minValue));
  if (filter.maxValue !== undefined) conditions.push(lte(pvpFits.value, filter.maxValue));
  if (filter.minKills !== undefined) conditions.push(gte(pvpShipKills.kills, filter.minKills));
  const rows = await db
    .select({ fit: fitSummary, pilot: pvpPilots, crawledAt: pvpCrawls.crawledAt })
    .from(pvpFits)
    .innerJoin(pvpPilots, and(eq(pvpPilots.crawlId, pvpFits.crawlId), eq(pvpPilots.characterId, pvpFits.characterId)))
    .innerJoin(pvpCrawls, eq(pvpCrawls.id, pvpFits.crawlId))
    .leftJoin(eveTypes, eq(eveTypes.id, pvpFits.shipTypeId))
    .leftJoin(pvpShipKills, hullKills)
    .where(and(...conditions))
    .orderBy(desc(pvpCrawls.crawledAt), desc(pvpCrawls.id), asc(pvpPilots.rank), ...fitOrder)
    .limit(SEARCH_LIMIT + 1);
  const kept = rows.slice(0, SEARCH_LIMIT);

  const weeks: { crawl: { id: number; crawledAt: string }; pilots: TopPvpPilot[] }[] = [];
  for (const row of kept) {
    let week = weeks.at(-1);
    if (week?.crawl.id !== row.fit.crawlId) {
      week = { crawl: { id: row.fit.crawlId, crawledAt: row.crawledAt.toISOString() }, pilots: [] };
      weeks.push(week);
    }
    if (week.pilots.at(-1)?.characterId !== row.pilot.characterId) {
      const pilots = [row.pilot];
      week.pilots.push(...withFits(pilots, kept.filter((other) => other.fit.crawlId === row.fit.crawlId).map((other) => other.fit)));
    }
  }
  return { weeks, fits: kept.length, truncated: rows.length > SEARCH_LIMIT };
}

/** One top PvP fit with its pilot, from the newest week that has it, or null if no week does. */
export async function topPvpFit(killmailId: number) {
  "use cache";
  cacheTag(PVP_FITS_TAG);
  cacheLife("days");
  if (!Number.isSafeInteger(killmailId) || killmailId <= 0) return null;
  const [row] = await db
    .select({ fit: pvpFits, pilot: pvpPilots, crawl: pvpCrawls, shipName: eveTypes.name, kills: pvpShipKills.kills, iskDestroyed: pvpShipKills.iskDestroyed })
    .from(pvpFits)
    .innerJoin(pvpPilots, and(eq(pvpPilots.crawlId, pvpFits.crawlId), eq(pvpPilots.characterId, pvpFits.characterId)))
    .innerJoin(pvpCrawls, eq(pvpCrawls.id, pvpFits.crawlId))
    .leftJoin(eveTypes, eq(eveTypes.id, pvpFits.shipTypeId))
    .leftJoin(pvpShipKills, hullKills)
    .where(eq(pvpFits.killmailId, killmailId))
    .orderBy(desc(pvpCrawls.crawledAt))
    .limit(1);
  if (!row) return null;
  const { fit, pilot, crawl } = row;
  const lost = fit.lostAt.toISOString().slice(0, 10);
  return {
    killmailId: fit.killmailId,
    name: fit.name,
    description: `Lost by ${pilot.name} on ${lost}, #${pilot.rank} on zKillboard's weekly ranking. ${zkillKillUrl(fit.killmailId)}`,
    shipTypeId: fit.shipTypeId,
    shipName: row.shipName,
    items: fit.items,
    losses: fit.losses,
    lostAt: fit.lostAt.toISOString(),
    solarSystemId: fit.solarSystemId,
    value: fit.value,
    // What the pilot killed in this hull that week; null when unknown.
    kills: row.kills,
    iskDestroyed: row.iskDestroyed,
    pilot: { characterId: pilot.characterId, name: pilot.name, rank: pilot.rank, corporationId: pilot.corporationId, allianceId: pilot.allianceId },
    crawl: { id: crawl.id, crawledAt: crawl.crawledAt.toISOString() },
  };
}

async function contentsOf(killmailId: number): Promise<Contents> {
  const fit = await topPvpFit(killmailId);
  if (!fit) throw new FittingError("Fit not found.");
  return { name: fit.name, description: fit.description, shipTypeId: fit.shipTypeId, items: fit.items };
}

/** Saves a top PvP fit as a private fit of the viewer's own; returns its id. */
export async function copyTopPvpFit(viewer: Viewer, killmailId: number): Promise<string> {
  return saveCopy(viewer, await contentsOf(killmailId));
}

/** Writes a top PvP fit to one of the viewer's characters' saved fittings in game. */
export async function sendTopPvpFit(viewer: Viewer, killmailId: number, characterId: number): Promise<void> {
  await writeToGame(viewer, characterId, await contentsOf(killmailId));
}
