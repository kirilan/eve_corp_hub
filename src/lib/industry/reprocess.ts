import type { PriceLevel } from "@/db/schema";
import type { Hub } from "./hubs";
import type { Pace } from "./pace";

/**
 * Reprocess-or-sell arithmetic, run in the browser so the price basis, skills and rates change the
 * figures at once. The server sends what it looked up (`Appraisal`); the yields and rates come from
 * `rates.ts`. Everything here is pure.
 */

export const OPTIONS = [
  { key: "base", label: "Reprocess, no skills" },
  { key: "skills", label: "Reprocess with skills" },
] as const;

export type OptionKey = (typeof OPTIONS)[number]["key"];

/** Sell into the hub's buy orders now, or list at its lowest sell order and wait. */
export type Basis = "buy" | "sell";

export type Book = { buy: PriceLevel[]; sell: PriceLevel[] };

export type AppraisalItem = {
  typeId: number;
  name: string;
  quantity: number;
  // Null when the item cannot be reprocessed at all. `oreSkill` is set for ore and ice.
  reprocess: { portionSize: number; materials: [number, number][]; oreSkill: number | null } | null;
};

/** What the server looked up for one pasted list; serialisable, so it can come back from a Server Action. */
export type Appraisal = {
  hub: Hub;
  items: AppraisalItem[];
  materialNames: Record<number, string>;
  // Processing skills of the pasted ore and ice, by type id.
  oreSkillNames: Record<number, string>;
  books: Record<number, Book>;
  // How fast each type trades in the hub's region; a type missing here has no history to go by.
  pace: Record<number, Pace>;
  // Lines no item name could be read from.
  unknown: string[];
  // Oldest price in use, ISO time; null when the hub had no prices to give.
  pricesAsOf: string | null;
  pricesAvailable: boolean;
  warnings: string[];
};

/** Yield of one reprocessing option: items on Scrapmetal Processing, ore and ice on their own skills. */
export type Yields = { scrap: number; ore: (oreSkill: number) => number };

/** Fractions: the station's cut of the materials, and the cuts of every sale. */
export type Pricing = { basis: Basis; reprocessingTax: number; salesTax: number; brokerFee: number };

/** Units of each material one stack yields, and the units too few to make up a whole portion. */
export function reprocessStack(item: AppraisalItem, yields: Yields, tax: number): { materials: Map<number, number>; leftover: number } {
  const materials = new Map<number, number>();
  if (!item.reprocess) return { materials, leftover: item.quantity };
  const { portionSize, materials: recipe, oreSkill } = item.reprocess;
  const rate = (oreSkill === null ? yields.scrap : yields.ore(oreSkill)) * (1 - tax);
  const portions = Math.floor(item.quantity / portionSize);
  for (const [typeId, perPortion] of recipe) {
    // The epsilon keeps 0.55 * 20 = 11.000000000000002 and its cousins on the right side of floor.
    const units = Math.floor(perPortion * portions * rate + 1e-9);
    if (units > 0) materials.set(typeId, (materials.get(typeId) ?? 0) + units);
  }
  return { materials, leftover: item.quantity - portions * portionSize };
}

/**
 * ISK buyers pay for `quantity` units at a hub, before tax and fees. Into buy orders, the sale walks
 * down the book from the best price, so a big stack fetches less per unit and may not sell in full.
 * Listed, every unit is priced at the lowest sell order.
 */
export function saleValue(book: Book | undefined, quantity: number, basis: Basis): { value: number; sold: number } {
  if (!book || quantity <= 0) return { value: 0, sold: 0 };
  if (basis === "sell") {
    const best = book.sell[0];
    return best ? { value: best[0] * quantity, sold: quantity } : { value: 0, sold: 0 };
  }
  let value = 0;
  let sold = 0;
  for (const [price, units] of book.buy) {
    const take = Math.min(units, quantity - sold);
    value += take * price;
    sold += take;
    if (sold >= quantity) break;
  }
  return { value, sold };
}

/** The share of a sale that reaches the wallet: sales tax always, the broker fee only on a listing. */
export function keptShare(pricing: Pricing): number {
  return Math.max(0, 1 - pricing.salesTax - (pricing.basis === "sell" ? pricing.brokerFee : 0));
}

export type ItemRow = {
  typeId: number;
  name: string;
  quantity: number;
  reprocessable: boolean;
  oreSkill: number | null;
  // Units below one portion, left over by reprocessing and counted as sold as they are.
  leftover: number;
  // ISK kept, after sales tax and broker fee.
  asIs: number;
  options: Record<OptionKey, number>;
  best: "asIs" | OptionKey;
  // No price for it at the hub, or the buy orders take only part of the stack.
  unpriced: boolean;
  partial: boolean;
};

export type MaterialRow = {
  typeId: number;
  name: string;
  units: Record<OptionKey, number>;
  // ISK kept, after sales tax and broker fee.
  value: Record<OptionKey, number>;
  unpriced: boolean;
  partial: boolean;
};

export type Result = {
  items: ItemRow[];
  materials: MaterialRow[];
  totals: {
    // ISK kept, after sales tax and broker fee.
    asIs: number;
    options: Record<OptionKey, number>;
    // Each item whichever way pays more: reprocessed where that beats selling it as it is.
    mixed: Record<OptionKey, number>;
    // Value of items that cannot be reprocessed, in every total as sold as they are.
    notReprocessable: number;
    // What sales tax and broker fees took, per column.
    fees: { asIs: number; options: Record<OptionKey, number> };
  };
};

const byOption = <T>(make: (key: OptionKey) => T) => Object.fromEntries(OPTIONS.map((o) => [o.key, make(o.key)])) as Record<OptionKey, T>;

export function appraise(appraisal: Appraisal, pricing: Pricing, yields: Record<OptionKey, Yields>): Result {
  const { items, books } = appraisal;
  const kept = keptShare(pricing);

  // Gross first (what buyers pay); the kept share is applied at the end, so fees show separately.
  const asIs = items.map((item) => saleValue(books[item.typeId], item.quantity, pricing.basis));
  const unitAsIs = items.map((_, i) => (asIs[i].sold > 0 ? asIs[i].value / asIs[i].sold : 0));

  // Materials are sold together, so each one's price is the average its whole pile fetches.
  const stacks = byOption((key) => items.map((item) => reprocessStack(item, yields[key], pricing.reprocessingTax)));
  const materialIds: number[] = [];
  const units = new Map<number, Record<OptionKey, number>>();
  for (const option of OPTIONS) {
    for (const stack of stacks[option.key]) {
      for (const [typeId, n] of stack.materials) {
        if (!units.has(typeId)) {
          units.set(typeId, byOption(() => 0));
          materialIds.push(typeId);
        }
        units.get(typeId)![option.key] += n;
      }
    }
  }
  const sales = new Map(materialIds.map((typeId) => [typeId, byOption((key) => saleValue(books[typeId], units.get(typeId)![key], pricing.basis))]));
  const unitPrice = new Map(
    materialIds.map((typeId) => [typeId, byOption((key) => (units.get(typeId)![key] > 0 ? sales.get(typeId)![key].value / units.get(typeId)![key] : 0))]),
  );
  const materials: MaterialRow[] = materialIds.map((typeId) => {
    const perOption = units.get(typeId)!;
    const sale = sales.get(typeId)!;
    return {
      typeId,
      name: appraisal.materialNames[typeId] ?? `Type ${typeId}`,
      units: perOption,
      value: byOption((key) => sale[key].value * kept),
      unpriced: OPTIONS.some((o) => perOption[o.key] > 0 && sale[o.key].sold === 0),
      partial: OPTIONS.some((o) => sale[o.key].sold > 0 && sale[o.key].sold < perOption[o.key]),
    };
  });

  const grossRows = items.map((item, i) => {
    const options = byOption((key) => {
      if (!item.reprocess) return asIs[i].value;
      const stack = stacks[key][i];
      let value = stack.leftover * unitAsIs[i];
      for (const [typeId, n] of stack.materials) value += n * unitPrice.get(typeId)![key];
      return value;
    });
    let best: ItemRow["best"] = "asIs";
    for (const option of OPTIONS) if (item.reprocess && options[option.key] > (best === "asIs" ? asIs[i].value : options[best])) best = option.key;
    return { asIs: asIs[i].value, options, best };
  });

  const rows: ItemRow[] = items.map((item, i) => ({
    typeId: item.typeId,
    name: item.name,
    quantity: item.quantity,
    reprocessable: item.reprocess !== null,
    oreSkill: item.reprocess?.oreSkill ?? null,
    leftover: item.reprocess ? stacks.base[i].leftover : 0,
    asIs: grossRows[i].asIs * kept,
    options: byOption((key) => grossRows[i].options[key] * kept),
    best: grossRows[i].best,
    unpriced: asIs[i].sold === 0,
    partial: asIs[i].sold > 0 && asIs[i].sold < item.quantity,
  }));

  const sum = (pick: (row: ItemRow) => number) => rows.reduce((total, row) => total + pick(row), 0);
  const fee = (net: number) => (kept > 0 ? (net / kept) * (1 - kept) : 0);
  const totals = {
    asIs: sum((row) => row.asIs),
    options: byOption((key) => sum((row) => row.options[key])),
    mixed: byOption((key) => sum((row) => Math.max(row.asIs, row.options[key]))),
    notReprocessable: sum((row) => (row.reprocessable ? 0 : row.asIs)),
  };
  return {
    items: rows,
    materials,
    totals: { ...totals, fees: { asIs: fee(totals.asIs), options: byOption((key) => fee(totals.options[key])) } },
  };
}
