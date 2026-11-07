import type { FittingItem } from "@/db/schema";
import { CATEGORY_DRONE, CATEGORY_FIGHTER, CATEGORY_SHIP, fitSignature, type TypeInfo } from "@/lib/fittings/eft";

/**
 * Turning zKillboard data into fits: the ranks page into a list of pilots, and a loss into the fit
 * the pilot flew. Pure functions; the crawl that feeds them is in `crawl.ts`.
 */

export const CATEGORY_CHARGE = 8;
const GROUP_CAPSULE = 29;
const GROUP_NANITE_PASTE = 916;

/** A killmail as zKillboard's API returns it: ESI's killmail plus zKillboard's own `zkb` block. */
export type ZkillKillmail = {
  killmail_id: number;
  killmail_time: string;
  solar_system_id: number;
  victim: {
    character_id?: number;
    corporation_id?: number;
    alliance_id?: number;
    ship_type_id: number;
    items?: KillmailItem[];
  };
  zkb: { hash: string; totalValue?: number; npc?: boolean };
};

type KillmailItem = {
  item_type_id: number;
  flag: number;
  quantity_destroyed?: number;
  quantity_dropped?: number;
  singleton?: number;
};

/**
 * Character ids in rank order from zKillboard's ranks page
 * (https://zkillboard.com/character/ranks/k/all/weekly/1/overallRank/asc/), a server-rendered table
 * whose rows start with the rank cell (`data-order` and the rank in bold) followed by a link to the character.
 */
export function parseRanks(html: string): { rank: number; characterId: number }[] {
  const out = new Map<number, number>();
  // Every numeric cell has a data-order; only the rank cell wraps its number in <strong>.
  for (const match of html.matchAll(/data-order="(\d+)"\s*>\s*<strong>[\s\S]{0,300}?href="\/character\/(\d+)\/"/g)) {
    const rank = Number(match[1]);
    const characterId = Number(match[2]);
    if (Number.isSafeInteger(characterId) && characterId > 0 && !out.has(characterId)) out.set(characterId, rank);
  }
  return [...out].map(([characterId, rank]) => ({ rank, characterId })).sort((a, b) => a.rank - b.rank);
}

/** ESI's numeric inventory flags for the places a fitting holds things, as the names fittings use. */
function placeOf(flag: number): string | null {
  if (flag >= 11 && flag <= 18) return `LoSlot${flag - 11}`;
  if (flag >= 19 && flag <= 26) return `MedSlot${flag - 19}`;
  if (flag >= 27 && flag <= 34) return `HiSlot${flag - 27}`;
  if (flag >= 92 && flag <= 94) return `RigSlot${flag - 92}`;
  if (flag >= 125 && flag <= 128) return `SubSystemSlot${flag - 125}`;
  if (flag === 87) return "DroneBay";
  if (flag === 158) return "FighterBay";
  if (flag === 5) return "Cargo";
  return null;
}

const isSlot = (place: string) => /Slot\d$/.test(place);

/** Every type id a loss mentions: what has to be looked up before `fitFromLoss`. */
export function typeIdsIn(loss: ZkillKillmail): number[] {
  return [loss.victim.ship_type_id, ...(loss.victim.items ?? []).map((item) => item.item_type_id)];
}

/**
 * The fit a pilot lost, in the shape fittings are stored and sent to the game, or null when the loss
 * says nothing about how to fit a ship: a capsule, an NPC kill, something that is not a ship, or a
 * hull with no modules on it. Modules keep their slots; charges loaded in them and charges and nanite
 * paste in cargo go to cargo, as EVE fittings carry them; drones and fighters keep their bays. Other
 * cargo (loot, spare modules, containers) is left out.
 */
export function fitFromLoss(loss: ZkillKillmail, types: Map<number, TypeInfo>): FittingItem[] | null {
  const ship = types.get(loss.victim.ship_type_id);
  if (loss.zkb.npc || !ship || ship.categoryId !== CATEGORY_SHIP || ship.groupId === GROUP_CAPSULE) return null;

  const items: FittingItem[] = [];
  const stacks = new Map<string, FittingItem>();
  const filled = new Set<string>();
  const add = (typeId: number, flag: string, quantity: number) => {
    const key = `${flag}:${typeId}`;
    const existing = stacks.get(key);
    if (existing) existing.quantity += quantity;
    else {
      const item = { type_id: typeId, flag, quantity };
      stacks.set(key, item);
      items.push(item);
    }
  };

  for (const item of loss.victim.items ?? []) {
    const place = placeOf(item.flag);
    const type = types.get(item.item_type_id);
    const quantity = (item.quantity_destroyed ?? 0) + (item.quantity_dropped ?? 0);
    if (!place || !type || quantity <= 0) continue;
    if (type.categoryId === CATEGORY_CHARGE || (place === "Cargo" && type.groupId === GROUP_NANITE_PASTE)) {
      if (place === "Cargo" || isSlot(place)) add(type.id, "Cargo", quantity);
    } else if (isSlot(place)) {
      // One module per slot; a second entry in the same slot would be a bug in the killmail.
      if (type.slot && !filled.has(place)) {
        filled.add(place);
        items.push({ type_id: type.id, flag: place, quantity: 1 });
      }
    } else if (place === "DroneBay" && type.categoryId === CATEGORY_DRONE) {
      add(type.id, place, quantity);
    } else if (place === "FighterBay" && type.categoryId === CATEGORY_FIGHTER) {
      add(type.id, place, quantity);
    }
  }
  return items.some((item) => isSlot(item.flag)) ? items : null;
}

/** What makes two losses the same fit: hull, modules, drones and fighters. Ammunition counts vary from loss to loss. */
export function loadoutKey(shipTypeId: number, items: FittingItem[]): string {
  return fitSignature(shipTypeId, items.filter((item) => item.flag !== "Cargo"));
}
