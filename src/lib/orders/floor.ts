/**
 * Reprocess floor and ceiling of an open order: what one unit's materials fetch at the order's own
 * station, the same arithmetic as the Industry calculator (`reprocess.ts`). Pure.
 *
 * - A sell order's **floor**: what one unit's materials fetch, after reprocessing yield and tax, sold into
 *   the station's buy orders. The item and its materials pay the same sales tax, so the floor compares
 *   with the order's price as it is: listed under it, the item brings less than reprocessing it would.
 * - A buy order's **ceiling**: the same, after sales tax too, since buying the item pays none. Bought
 *   above it, the item is worth less reprocessed than it cost.
 *
 * Broker fees are left out on both sides: the order already paid its own. The materials of every unit
 * left on the order are sold together, walking down the buy book, and units short of a whole portion
 * count as their share of one (EVE reprocesses whole portions only), as the calculator's pro-rata figure.
 */

import type { Reprocessing } from "@/lib/industry/materials";
import { type Book, leftoverShare, reprocessStack, saleValue, type Yields } from "@/lib/industry/reprocess";

/** The skill levels the yields use; a missing one is untrained. */
export type ReprocessSkills = {
  scrapmetal: number;
  reprocessing: number;
  efficiency: number;
  // Ore and ice processing skills by type id.
  ore: Record<number, number>;
};

export const NO_SKILLS: ReprocessSkills = { scrapmetal: 0, reprocessing: 0, efficiency: 0, ore: {} };

/**
 * Yields at a facility with base yield `base` (an NPC station's `reprocessing_efficiency`, 50% in a
 * structure without rigs): items on Scrapmetal Processing, ore and ice on the reprocessing skills and
 * their own. No implant: ESI does not say which one is plugged in.
 */
export function facilityYields(base: number, skills: ReprocessSkills): Yields {
  return {
    scrap: base * (1 + 0.02 * skills.scrapmetal),
    ore: (oreSkill) => base * (1 + 0.03 * skills.reprocessing) * (1 + 0.02 * skills.efficiency) * (1 + 0.02 * (skills.ore[oreSkill] ?? 0)),
  };
}

export type FloorInput = {
  side: "buy" | "sell";
  // The order's price and units left.
  price: number;
  units: number;
  reprocess: Reprocessing;
  // Order books at the order's station, by material type id.
  books: ReadonlyMap<number, Book> | Record<number, Book>;
  yields: Yields;
  reprocessingTax: number;
  salesTax: number;
};

export type Floor = {
  kind: "floor" | "ceiling";
  // ISK per unit of the item (see above).
  price: number;
  // The order's price over `price`: under 1 a sell order is below its floor, over 1 a buy order above its ceiling.
  ratio: number;
  // The share of the recipe reaching the hangar (yield less the station's tax).
  rate: number;
  // Some materials have no buy orders at the station, or too few for all of them: `price` counts only what sells.
  partial: boolean;
};

const bookOf = (books: FloorInput["books"], typeId: number): Book | undefined =>
  books instanceof Map ? books.get(typeId) : (books as Record<number, Book>)[typeId];

/** The order's reprocess floor (sell) or ceiling (buy); null when none of its materials has a buyer at the station. */
export function reprocessFloor(input: FloorInput): Floor | null {
  const { reprocess, yields, reprocessingTax } = input;
  const quantity = Math.max(1, input.units);
  const item = { typeId: 0, name: "", quantity, reprocess };
  const stack = reprocessStack(item, yields, reprocessingTax);
  const materials = new Map(stack.materials);
  for (const [typeId, share] of leftoverShare(item, stack.leftover, yields, reprocessingTax)) {
    if (share > 0) materials.set(typeId, (materials.get(typeId) ?? 0) + share);
  }
  let value = 0;
  let partial = false;
  let sold = false;
  for (const [typeId, units] of materials) {
    const sale = saleValue(bookOf(input.books, typeId), units, "buy");
    value += sale.value;
    if (sale.sold > 0) sold = true;
    if (sale.sold < units - 1e-9) partial = true;
  }
  if (!sold || value <= 0) return null;
  const perUnit = value / quantity;
  const kind = input.side === "sell" ? "floor" : "ceiling";
  const price = kind === "floor" ? perUnit : perUnit * Math.max(0, 1 - input.salesTax);
  const rate = (reprocess.oreSkill === null ? yields.scrap : yields.ore(reprocess.oreSkill)) * (1 - reprocessingTax);
  return { kind, price, ratio: input.price / price, rate, partial };
}
