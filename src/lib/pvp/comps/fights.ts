import type { FittingItem } from "@/db/schema";
import type { TypeInfo } from "@/lib/fittings/eft";
import { fitFromLoss, loadoutKey } from "../killmail";
import { isSmallGangCandidate } from "./filter";
import type { RawKillmail } from "./r2z2";
import { isBannedModule, isHull, pvpType } from "./static-data";

/**
 * One day of zKillboard's dump turned into fight sides, the pure part of the fleet comps pipeline
 * (`sync.ts` feeds it and stores what it returns):
 * 1. keep the killmails that can say anything about small-gang PvP (`filter.ts`) and price them;
 * 2. group them into fights: kills in one system, each within 15 minutes of the one before;
 * 3. split each fight into sides: groups (alliance, else corporation, else the pilot) that shoot the
 *    same target are one side;
 * 4. summarise each side: pilots, one hull per pilot, ISK destroyed and lost, enemy pilots.
 *
 * A fight still going at midnight (its last kill within 15 minutes of it) is not summarised: its kills
 * are carried into the next day's run, which finishes it. Every fight is therefore summarised once, by
 * the run of the day it ends, and keeps the id and the day of its first kill.
 */

/** The price cap per ship, hull and fit. */
export const PRICE_CAP = 1_000_000_000;
/** Kills further apart than this in one system are separate fights. */
const FIGHT_GAP_S = 15 * 60;
/** Sides of these sizes are stored; the comps use 3 to 7, the rest is kept for later. */
export const MIN_SIDE = 3;
export const MAX_SIDE = 12;
/** Gang sizes the comps rank. */
export const GANG_SIZES = [3, 4, 5, 6, 7] as const;

/** A pilot's group: an alliance, else a player corporation, else the pilot alone. */
type Group = string;

/** What the pipeline keeps of a killmail. Also what is carried overnight, so it stays small. */
export type CompKill = {
  id: number;
  // Unix seconds.
  t: number;
  system: number;
  victim: { character: number; group: Group; ship: number };
  attackers: [character: number, group: Group, ship: number | null][];
  // Hull plus fit (modules, rigs, subsystems, drones, loaded charges), in ISK.
  value: number;
  // The fit, when it is one the comps may suggest: under the price cap and with no officer,
  // deadspace or abyssal module.
  fit: FittingItem[] | null;
};

export type SideRow = {
  fightId: number;
  side: number;
  // The UTC day of the fight's first kill.
  day: string;
  systemId: number;
  pilots: number;
  // Pilots of every other side in the fight.
  enemies: number;
  iskKilled: number;
  iskLost: number;
  // One hull per pilot whose hull is known: the one they lost, else the one they flew most.
  hulls: number[];
};

export type FitRow = {
  killmailId: number;
  fightId: number;
  side: number;
  day: string;
  characterId: number;
  shipTypeId: number;
  items: FittingItem[];
  loadout: string;
  value: number;
};

/** Losses per hull on one day: all kept losses, and those under the price cap. */
export type HullLosses = Map<number, { losses: number; affordable: number }>;

// Inventory flags that make up a fit: low, mid and high slots, rigs, subsystems, the drone bay.
const isFitFlag = (flag: number) => (flag >= 11 && flag <= 34) || (flag >= 92 && flag <= 99) || (flag >= 125 && flag <= 132) || flag === 87;

const NPC_CORPORATIONS = { from: 1_000_000, to: 2_000_000 };

function groupOf(pilot: { character_id?: number; corporation_id?: number; alliance_id?: number }): Group {
  if (pilot.alliance_id) return `a${pilot.alliance_id}`;
  const corp = pilot.corporation_id;
  if (corp && !(corp >= NPC_CORPORATIONS.from && corp < NPC_CORPORATIONS.to)) return `c${corp}`;
  return `p${pilot.character_id}`;
}

/** What `fitFromLoss` needs of a type, from the static data: it only asks whether a module has a slot. */
function typeInfo(typeId: number): TypeInfo | undefined {
  const type = pvpType(typeId);
  if (!type) return undefined;
  const fitted = type.categoryId === 7 || type.categoryId === 32;
  return { id: typeId, name: "", groupId: type.groupId, categoryId: type.categoryId, slot: fitted ? "hi" : null };
}

const typeLookup = {
  get: typeInfo,
} as unknown as Map<number, TypeInfo>;

/** A kept killmail, priced: ESI average prices, the static data's base price where ESI has none. */
export function compKill(killmail: RawKillmail, prices: Map<number, number>): CompKill {
  const { victim } = killmail;
  const price = (typeId: number) => prices.get(typeId) ?? pvpType(typeId)?.basePrice ?? 0;
  let value = price(victim.ship_type_id);
  let banned = false;
  for (const item of victim.items ?? []) {
    if (!isFitFlag(item.flag)) continue;
    value += ((item.quantity_destroyed ?? 0) + (item.quantity_dropped ?? 0)) * price(item.item_type_id);
    if (isBannedModule(item.item_type_id)) banned = true;
  }
  const fit = banned || value > PRICE_CAP ? null : fitFromLoss({ ...killmail, zkb: { hash: "" } }, typeLookup);
  return {
    id: killmail.killmail_id,
    t: Math.floor(Date.parse(killmail.killmail_time) / 1000),
    system: killmail.solar_system_id,
    victim: { character: victim.character_id!, group: groupOf(victim), ship: victim.ship_type_id },
    attackers: killmail.attackers.flatMap((a) =>
      a.character_id === undefined ? [] : [[a.character_id, groupOf(a), a.ship_type_id ?? null] as CompKill["attackers"][number]],
    ),
    value,
    fit,
  };
}

/** Kills grouped into fights, each in time order; fights in the order of their first kill. */
export function groupFights(kills: CompKill[]): CompKill[][] {
  const bySystem = new Map<number, CompKill[]>();
  for (const kill of kills) {
    const list = bySystem.get(kill.system);
    if (list) list.push(kill);
    else bySystem.set(kill.system, [kill]);
  }
  const fights: CompKill[][] = [];
  for (const list of bySystem.values()) {
    list.sort((a, b) => a.t - b.t || a.id - b.id);
    let fight = [list[0]];
    for (const kill of list.slice(1)) {
      if (kill.t - fight[fight.length - 1].t <= FIGHT_GAP_S) fight.push(kill);
      else {
        fights.push(fight);
        fight = [kill];
      }
    }
    fights.push(fight);
  }
  return fights.sort((a, b) => a[0].t - b[0].t || a[0].id - b[0].id);
}

export type Side = Omit<SideRow, "fightId" | "side" | "day" | "systemId"> & {
  // The side's losses with a fit the comps may suggest, and who lost them.
  fits: CompKill[];
};

/**
 * A fight split into sides. Groups that shoot the same target are one side (merged across the whole
 * fight); a victim's group that shot nobody is a side of its own. Attackers in the victim's own group
 * are left out of that kill. Sides come in the order they first appear.
 */
export function splitSides(fight: CompKill[]): Side[] {
  const parent = new Map<Group, Group>();
  const find = (group: Group): Group => {
    if (!parent.has(group)) parent.set(group, group);
    let root = group;
    while (parent.get(root) !== root) root = parent.get(root)!;
    // Path compression.
    let node = group;
    while (node !== root) {
      const up = parent.get(node)!;
      parent.set(node, root);
      node = up;
    }
    return root;
  };
  for (const kill of fight) {
    find(kill.victim.group);
    const groups = [...new Set(kill.attackers.map(([, group]) => group).filter((group) => group !== kill.victim.group))];
    for (const group of groups.slice(1)) parent.set(find(group), find(groups[0]));
    for (const group of groups) find(group);
  }

  type Building = { pilots: Set<number>; lost: Map<number, number>; flown: Map<number, Map<number, number>>; iskKilled: number; iskLost: number; fits: CompKill[] };
  const sides = new Map<Group, Building>();
  const sideOf = (group: Group) => {
    const root = find(group);
    let side = sides.get(root);
    if (!side) sides.set(root, (side = { pilots: new Set(), lost: new Map(), flown: new Map(), iskKilled: 0, iskLost: 0, fits: [] }));
    return side;
  };
  for (const kill of fight) {
    const { character, group, ship } = kill.victim;
    const victimSide = sideOf(group);
    victimSide.pilots.add(character);
    victimSide.lost.set(character, ship);
    victimSide.iskLost += kill.value;
    if (kill.fit) victimSide.fits.push(kill);
    const shooters = new Set<Building>();
    for (const [attacker, attackerGroup, attackerShip] of kill.attackers) {
      if (attackerGroup === group) continue;
      const side = sideOf(attackerGroup);
      shooters.add(side);
      side.pilots.add(attacker);
      if (attackerShip !== null && isHull(attackerShip)) {
        const flown = side.flown.get(attacker) ?? new Map<number, number>();
        flown.set(attackerShip, (flown.get(attackerShip) ?? 0) + 1);
        side.flown.set(attacker, flown);
      }
    }
    for (const side of shooters) side.iskKilled += kill.value;
  }

  const total = [...sides.values()].reduce((sum, side) => sum + side.pilots.size, 0);
  return [...sides.values()].map((side) => {
    const hulls: number[] = [];
    for (const pilot of side.pilots) {
      const lost = side.lost.get(pilot);
      if (lost !== undefined) hulls.push(lost);
      else {
        let best: [number, number] | null = null;
        for (const [hull, count] of side.flown.get(pilot) ?? []) if (!best || count > best[1]) best = [hull, count];
        if (best) hulls.push(best[0]);
      }
    }
    return { pilots: side.pilots.size, enemies: total - side.pilots.size, iskKilled: side.iskKilled, iskLost: side.iskLost, hulls, fits: side.fits };
  });
}

/** A fair fight: the enemy had at least half our pilots, and at least 2. */
export const isFair = (side: { pilots: number; enemies: number }) => side.enemies >= Math.max(2, Math.ceil(side.pilots / 2));
/** A win: the side destroyed more ISK than it lost. */
export const isWin = (side: { iskKilled: number; iskLost: number }) => side.iskKilled > side.iskLost;

const utcDayOf = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

export type DayResult = {
  // Killmails kept by the filter.
  kept: number;
  sides: SideRow[];
  // Suggestable fits lost by fair, winning sides of 3 to 7 pilots.
  fits: FitRow[];
  hullLosses: HullLosses;
  // Kills of fights still going at midnight, for the next day's run.
  carry: CompKill[];
};

/**
 * One UTC day: its killmails, plus the kills the day before carried over. Prices are ESI's average
 * prices by type.
 */
export function processDay(day: string, killmails: RawKillmail[], carried: CompKill[], prices: Map<number, number>): DayResult {
  const midnight = Date.parse(`${day}T00:00:00Z`) / 1000 + 86_400;
  const hullLosses: HullLosses = new Map();
  const seen = new Set(carried.map((kill) => kill.id));
  const kills = [...carried];
  let kept = 0;
  for (const killmail of killmails) {
    if (!isSmallGangCandidate(killmail) || seen.has(killmail.killmail_id)) continue;
    seen.add(killmail.killmail_id);
    kept += 1;
    const kill = compKill(killmail, prices);
    kills.push(kill);
    const hull = hullLosses.get(kill.victim.ship) ?? { losses: 0, affordable: 0 };
    hull.losses += 1;
    if (kill.value <= PRICE_CAP) hull.affordable += 1;
    hullLosses.set(kill.victim.ship, hull);
  }

  const sides: SideRow[] = [];
  const fits: FitRow[] = [];
  const carry: CompKill[] = [];
  for (const fight of groupFights(kills)) {
    if (midnight - fight[fight.length - 1].t <= FIGHT_GAP_S) {
      carry.push(...fight);
      continue;
    }
    const first = fight[0];
    const fightDay = utcDayOf(first.t);
    splitSides(fight).forEach((side, index) => {
      if (side.pilots < MIN_SIDE || side.pilots > MAX_SIDE) return;
      const { fits: losses, ...summary } = side;
      sides.push({ fightId: first.id, side: index, day: fightDay, systemId: first.system, ...summary });
      if (side.pilots > GANG_SIZES[GANG_SIZES.length - 1] || !isFair(side) || !isWin(side)) return;
      for (const loss of losses) {
        fits.push({
          killmailId: loss.id,
          fightId: first.id,
          side: index,
          day: fightDay,
          characterId: loss.victim.character,
          shipTypeId: loss.victim.ship,
          items: loss.fit!,
          loadout: loadoutKey(loss.victim.ship, loss.fit!),
          value: loss.value,
        });
      }
    });
  }
  return { kept, sides, fits, hullLosses, carry };
}
