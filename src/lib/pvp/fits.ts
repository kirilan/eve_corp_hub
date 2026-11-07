import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { db } from "@/db";
import { eveTypes, pvpCrawls, pvpFits, pvpPilots } from "@/db/schema";
import type { Viewer } from "@/lib/auth/accounts";
import { FittingError, saveCopy, writeToGame, type Contents } from "@/lib/fittings/store";

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

/** Every crawled week, newest first. */
export async function pvpWeeks() {
  "use cache";
  cacheTag(PVP_FITS_TAG);
  cacheLife("days");
  const rows = await db.select().from(pvpCrawls).orderBy(desc(pvpCrawls.crawledAt));
  return rows.map((row) => ({ id: row.id, crawledAt: row.crawledAt.toISOString() }));
}

/**
 * One week's pilots in rank order, each with their fits, most-lost first: the week with id `crawlId`,
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
  const [pilots, fits] = await Promise.all([
    db.select().from(pvpPilots).where(eq(pvpPilots.crawlId, crawl.id)).orderBy(asc(pvpPilots.rank)),
    db
      .select({
        killmailId: pvpFits.killmailId,
        characterId: pvpFits.characterId,
        shipTypeId: pvpFits.shipTypeId,
        shipName: eveTypes.name,
        losses: pvpFits.losses,
        lostAt: pvpFits.lostAt,
        value: pvpFits.value,
      })
      .from(pvpFits)
      .leftJoin(eveTypes, eq(eveTypes.id, pvpFits.shipTypeId))
      .where(eq(pvpFits.crawlId, crawl.id))
      .orderBy(desc(pvpFits.losses), desc(pvpFits.lostAt)),
  ]);
  return {
    crawl: { id: crawl.id, crawledAt: crawl.crawledAt.toISOString() },
    pilots: pilots.map((pilot) => ({
      characterId: pilot.characterId,
      rank: pilot.rank,
      name: pilot.name,
      corporationId: pilot.corporationId,
      allianceId: pilot.allianceId,
      losses: pilot.losses,
      fits: fits
        .filter((fit) => fit.characterId === pilot.characterId)
        .map((fit) => ({ ...fit, lostAt: fit.lostAt.toISOString() })),
    })),
  };
}

export type TopPvpPilot = Awaited<ReturnType<typeof topPvpPilots>>["pilots"][number];

/** One top PvP fit with its pilot, from the newest week that has it, or null if no week does. */
export async function topPvpFit(killmailId: number) {
  "use cache";
  cacheTag(PVP_FITS_TAG);
  cacheLife("days");
  if (!Number.isSafeInteger(killmailId) || killmailId <= 0) return null;
  const [row] = await db
    .select({ fit: pvpFits, pilot: pvpPilots, crawl: pvpCrawls, shipName: eveTypes.name })
    .from(pvpFits)
    .innerJoin(pvpPilots, and(eq(pvpPilots.crawlId, pvpFits.crawlId), eq(pvpPilots.characterId, pvpFits.characterId)))
    .innerJoin(pvpCrawls, eq(pvpCrawls.id, pvpFits.crawlId))
    .leftJoin(eveTypes, eq(eveTypes.id, pvpFits.shipTypeId))
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
