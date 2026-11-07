import "server-only";
import { and, gte, lt } from "drizzle-orm";
import { db } from "@/db";
import { pvpCrawls, pvpFits, pvpPilots, pvpShipKills } from "@/db/schema";
import { names } from "@/lib/eve/esi";
import { typesById } from "@/lib/eve/types";
import { fitFromLoss, loadoutKey, parseRanks, typeIdsIn, type ZkillKillmail } from "./killmail";
import { weeklyLosses, weeklyRanksPage, weeklyShipKills, ZkillError } from "./zkill";

export const TOP_PILOTS = 50;
const SHIP_CATEGORY = 6;

type Pilot = Omit<typeof pvpPilots.$inferInsert, "crawlId">;
type Fit = Omit<typeof pvpFits.$inferInsert, "crawlId">;
type Kills = Omit<typeof pvpShipKills.$inferInsert, "crawlId">;

/** The fit name: "<ship> (<pilot>)", shortening the pilot's name first to stay within EVE's 50 characters. */
export function pvpFitName(shipName: string, pilotName: string): string {
  const room = 50 - shipName.length - 3;
  if (room < 3) return shipName.slice(0, 50);
  return `${shipName} (${pilotName.length > room ? `${pilotName.slice(0, room - 1)}…` : pilotName})`;
}

/** One pilot's distinct loadouts from their losses (newest first), each kept as its most recent loss. */
async function fitsOf(characterId: number, pilotName: string, losses: ZkillKillmail[], signal?: AbortSignal): Promise<Fit[]> {
  const types = await typesById(losses.flatMap(typeIdsIn), signal);
  const byLoadout = new Map<string, Fit>();
  for (const loss of losses) {
    const items = fitFromLoss(loss, types);
    if (!items) continue;
    const shipTypeId = loss.victim.ship_type_id;
    const key = loadoutKey(shipTypeId, items);
    const seen = byLoadout.get(key);
    if (seen) {
      seen.losses! += 1;
      continue;
    }
    byLoadout.set(key, {
      killmailId: loss.killmail_id,
      characterId,
      shipTypeId,
      name: pvpFitName(types.get(shipTypeId)!.name, pilotName),
      items,
      losses: 1,
      lostAt: new Date(loss.killmail_time),
      solarSystemId: loss.solar_system_id,
      value: loss.zkb.totalValue ?? null,
    });
  }
  return [...byLoadout.values()];
}

/**
 * The weekly crawl: the top pilots of zKillboard's 7-day killers ranking, their losses over the same
 * 7 days and the distinct fits in them, and what they killed in each hull they flew, saved as a new week in one transaction: earlier weeks stay,
 * a failure part way saves nothing, and a re-run on the same UTC day replaces that day's crawl.
 */
export async function crawlPvpFits(signal?: AbortSignal, now = new Date()) {
  const ranked = parseRanks(await weeklyRanksPage(signal)).slice(0, TOP_PILOTS);
  if (ranked.length === 0) throw new ZkillError("Found no pilots on zKillboard's ranks page; its layout may have changed.");
  const pilotNames = new Map((await names(ranked.map((pilot) => pilot.characterId))).map((entry) => [entry.id, entry.name]));

  const pilots: Pilot[] = [];
  const fits: Fit[] = [];
  const kills: Kills[] = [];
  for (const { rank, characterId } of ranked) {
    const name = pilotNames.get(characterId) ?? `Character ${characterId}`;
    const losses = (await weeklyLosses(characterId, signal)).filter((loss) => loss.victim.character_id === characterId);
    const latest = losses[0]?.victim;
    pilots.push({
      characterId,
      rank,
      name,
      corporationId: latest?.corporation_id ?? null,
      allianceId: latest?.alliance_id ?? null,
      losses: losses.length,
    });
    fits.push(...(await fitsOf(characterId, name, losses, signal)));
    kills.push(...(await weeklyShipKills(characterId, signal)).map((ship) => ({ ...ship, characterId })));
  }

  // Hulls killed with but never lost are not among the losses' types: cache their names too. zKillboard
  // also credits kills made from a structure (an Azbel's guns); only ships count here.
  const hullTypes = await typesById([...new Set(kills.map((row) => row.shipTypeId))], signal);
  const shipKills = kills.filter((row) => hullTypes.get(row.shipTypeId)?.categoryId === SHIP_CATEGORY);

  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const nextDay = new Date(day.getTime() + 24 * 60 * 60 * 1000);
  const crawlId = await db.transaction(async (tx) => {
    await tx.delete(pvpCrawls).where(and(gte(pvpCrawls.crawledAt, day), lt(pvpCrawls.crawledAt, nextDay)));
    const [{ id }] = await tx.insert(pvpCrawls).values({ crawledAt: now }).returning({ id: pvpCrawls.id });
    await tx.insert(pvpPilots).values(pilots.map((pilot) => ({ ...pilot, crawlId: id })));
    if (fits.length > 0) await tx.insert(pvpFits).values(fits.map((fit) => ({ ...fit, crawlId: id })));
    if (shipKills.length > 0) await tx.insert(pvpShipKills).values(shipKills.map((row) => ({ ...row, crawlId: id })));
    return id;
  });
  return { crawlId, pilots: pilots.length, fits: fits.length, ships: shipKills.length };
}
