import type { FittingItem } from "@/db/schema";
import { capIsk, DEFAULT_CAP, GANG_SIZES, isFair, isWin, type PriceCap } from "./fights";
import { mixOf, ROLES, roleOf, type Mix, type Role } from "./roles";

/**
 * The comps themselves, from stored sides: which role mixes win most at each gang size, how the core
 * grows from 3 to 7 pilots, and which hulls fill each role. Pure; the same for the live 30 days and a
 * saved month.
 *
 * Only fair fights count (`isFair`), and only sides whose every hull is affordable at the price cap: at
 * least half of that hull's losses in the period cost the cap or less (1B, or a cheaper cap). A side
 * flying a hull with no loss in the period cannot be priced and is left out too.
 */

/** A mix or hull shows once it has this many fair fights; under `SOLID_FIGHTS` it is marked low sample. */
export const MIN_FIGHTS = 30;
export const SOLID_FIGHTS = 50;

export type ScoredSide = { fightId: number; side: number; pilots: number; enemies: number; iskKilled: number; iskLost: number; hulls: number[] };
export type ScoredFit = { killmailId: number; fightId: number; side: number; characterId: number; shipTypeId: number; items: FittingItem[]; loadout: string; value: number };

export type MixStat = { mix: Mix; fights: number; wins: number; low: number; iskKilled: number; iskLost: number };
export type ExampleFit = { killmailId: number; characterId: number; items: FittingItem[]; value: number; losses: number };
export type HullStat = { typeId: number; fights: number; wins: number; low: number; fit: ExampleFit | null };
export type GrowthStep = { pilots: number; mix: Mix; swap: boolean };

export type CompResults = {
  // Fair sides of 3 to 7 pilots counted, and those left out for an over-cap or unpriced hull.
  sides: number;
  overCap: number;
  sizes: { pilots: number; sides: number; mixes: MixStat[] }[];
  growth: GrowthStep[];
  hulls: Record<Role, HullStat[]>;
};

/** The low end of the 95% Wilson interval of a win rate. */
export function wilsonLow(wins: number, fights: number, z = 1.96): number {
  if (fights === 0) return 0;
  const p = wins / fights;
  const z2 = z * z;
  return (p + z2 / (2 * fights) - z * Math.sqrt((p * (1 - p)) / fights + z2 / (4 * fights * fights))) / (1 + z2 / fights);
}

/** Whether a hull's typical fit is under the cap: at least half its losses cost the cap or less. */
export const isAffordable = (losses: { losses: number; affordable: number } | undefined) =>
  losses !== undefined && losses.losses > 0 && losses.affordable * 2 >= losses.losses;

const contains = (big: Mix, small: Mix) => big.every((count, i) => count >= small[i]);
const byLow = <T extends { low: number; fights: number }>(a: T, b: T) => b.low - a.low || b.fights - a.fights;

/** `hullLosses` counts, per hull, all losses and those at or under `cap` (see `lossesAt`). */
export function scoreComps(
  sides: ScoredSide[],
  hullLosses: Map<number, { losses: number; affordable: number }>,
  fits: ScoredFit[],
  cap: PriceCap = DEFAULT_CAP,
): CompResults {
  const smallest = GANG_SIZES[0];
  const largest = GANG_SIZES[GANG_SIZES.length - 1];
  const fair = sides.filter((side) => side.pilots >= smallest && side.pilots <= largest && isFair(side));
  const counted = fair.filter((side) => side.hulls.every((hull) => isAffordable(hullLosses.get(hull))));

  // Mixes per gang size.
  const sizes = GANG_SIZES.map((pilots) => {
    const byMix = new Map<string, MixStat>();
    let total = 0;
    for (const side of counted) {
      if (side.pilots !== pilots) continue;
      total += 1;
      const mix = mixOf(side.pilots, side.hulls);
      const key = mix.join(",");
      const stat = byMix.get(key) ?? { mix, fights: 0, wins: 0, low: 0, iskKilled: 0, iskLost: 0 };
      stat.fights += 1;
      if (isWin(side)) stat.wins += 1;
      stat.iskKilled += side.iskKilled;
      stat.iskLost += side.iskLost;
      byMix.set(key, stat);
    }
    const mixes = [...byMix.values()].filter((stat) => stat.fights >= MIN_FIGHTS);
    for (const stat of mixes) stat.low = wilsonLow(stat.wins, stat.fights);
    return { pilots, sides: total, mixes: mixes.sort(byLow) };
  });

  // The growth path: the best 3-pilot mix, then at each size the best mix that is the step before plus
  // one pilot, else that size's best mix, marked as a swap.
  const growth: GrowthStep[] = [];
  for (const { pilots, mixes } of sizes) {
    const previous = growth.at(-1);
    const grown = previous && previous.pilots === pilots - 1 ? mixes.find((stat) => contains(stat.mix, previous.mix)) : undefined;
    const step = grown ?? mixes[0];
    if (step) growth.push({ pilots, mix: step.mix, swap: growth.length > 0 && !grown });
  }

  // Hulls per role, all gang sizes pooled: one fight per side a hull flew in.
  const hullStats = new Map<number, HullStat>();
  const winning = new Set<string>();
  for (const side of counted) {
    if (isWin(side)) winning.add(`${side.fightId}:${side.side}`);
    for (const hull of new Set(side.hulls)) {
      const stat = hullStats.get(hull) ?? { typeId: hull, fights: 0, wins: 0, low: 0, fit: null };
      stat.fights += 1;
      if (isWin(side)) stat.wins += 1;
      hullStats.set(hull, stat);
    }
  }
  // Example fits: per hull, the loadout winning sides lost most, shown by its latest loss.
  const loadouts = new Map<number, Map<string, { count: number; latest: ScoredFit }>>();
  for (const fit of fits) {
    if (!winning.has(`${fit.fightId}:${fit.side}`) || fit.value > capIsk(cap)) continue;
    const byLoadout = loadouts.get(fit.shipTypeId) ?? new Map<string, { count: number; latest: ScoredFit }>();
    const entry = byLoadout.get(fit.loadout);
    if (!entry) byLoadout.set(fit.loadout, { count: 1, latest: fit });
    else {
      entry.count += 1;
      if (fit.killmailId > entry.latest.killmailId) entry.latest = fit;
    }
    loadouts.set(fit.shipTypeId, byLoadout);
  }
  const hulls = Object.fromEntries(ROLES.map((role) => [role, [] as HullStat[]])) as Record<Role, HullStat[]>;
  for (const stat of hullStats.values()) {
    const role = roleOf(stat.typeId);
    // Logi lands on killmails mostly when it dies, so its win rate says little: logi hulls are all
    // listed, by how often they flew.
    if (role !== "logi" && stat.fights < MIN_FIGHTS) continue;
    stat.low = wilsonLow(stat.wins, stat.fights);
    let best: { count: number; latest: ScoredFit } | undefined;
    for (const entry of loadouts.get(stat.typeId)?.values() ?? []) {
      if (!best || entry.count > best.count || (entry.count === best.count && entry.latest.killmailId > best.latest.killmailId)) best = entry;
    }
    if (best) {
      const { killmailId, characterId, items, value } = best.latest;
      stat.fit = { killmailId, characterId, items, value, losses: best.count };
    }
    hulls[role].push(stat);
  }
  for (const role of ROLES) hulls[role].sort(role === "logi" ? (a, b) => b.fights - a.fights || b.low - a.low : byLow);

  return { sides: counted.length, overCap: fair.length - counted.length, sizes, growth, hulls };
}
