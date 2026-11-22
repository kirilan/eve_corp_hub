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
  const { portionSize, materials: recipe } = item.reprocess;
  const rate = yieldRate(item, yields, tax);
  const portions = Math.floor(item.quantity / portionSize);
  for (const [typeId, perPortion] of recipe) {
    // The epsilon keeps 0.55 * 20 = 11.000000000000002 and its cousins on the right side of floor.
    const units = Math.floor(perPortion * portions * rate + 1e-9);
    if (units > 0) materials.set(typeId, (materials.get(typeId) ?? 0) + units);
  }
  return { materials, leftover: item.quantity - portions * portionSize };
}

/** Share of an item's recipe that reaches the hangar: its skill's yield less the station's tax. */
function yieldRate(item: AppraisalItem, yields: Yields, tax: number): number {
  const oreSkill = item.reprocess?.oreSkill ?? null;
  return (oreSkill === null ? yields.scrap : yields.ore(oreSkill)) * (1 - tax);
}

/**
 * Materials the units short of a whole portion would yield if EVE reprocessed part portions, in
 * fractions of a unit. It does not: this only prices them for the pro-rata figure.
 */
export function leftoverShare(item: AppraisalItem, leftover: number, yields: Yields, tax: number): [number, number][] {
  if (!item.reprocess || leftover <= 0) return [];
  const { portionSize, materials: recipe } = item.reprocess;
  const rate = yieldRate(item, yields, tax);
  return recipe.map(([typeId, perPortion]) => [typeId, (perPortion * leftover * rate) / portionSize]);
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

/** The best order on the side a sale goes into: the highest buy, or the lowest sell when listing. */
export function topPrice(book: Book | undefined, basis: Basis): number | null {
  const level = basis === "sell" ? book?.sell[0] : book?.buy[0];
  return level ? level[0] : null;
}

export type ItemRow = {
  typeId: number;
  name: string;
  quantity: number;
  reprocessable: boolean;
  oreSkill: number | null;
  // Units per reprocessing batch (1 when not reprocessable), and the units below one, left over by
  // reprocessing and counted as sold as they are.
  portionSize: number;
  leftover: number;
  // ISK kept, after sales tax and broker fee.
  asIs: number;
  options: Record<OptionKey, number>;
  // As `options`, but with the units short of a portion counted as their share of a portion's
  // materials. EVE reprocesses whole portions only, so this is a guide, not a figure you can get.
  // Null when nothing is left over.
  proRata: Record<OptionKey, number> | null;
  best: "asIs" | OptionKey;
  // What buyers pay per unit as it is, before tax and fees: the average over the units sold (lower
  // than `topPrice` when a sale into buy orders walks down the book). Null without a price.
  unitPrice: number | null;
  // The best order on the side being sold into: the highest buy, or the lowest sell when listing.
  topPrice: number | null;
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
  // What buyers pay per unit for each option's pile, before tax and fees, as for items.
  unitPrice: Record<OptionKey, number | null>;
  topPrice: number | null;
  unpriced: boolean;
  partial: boolean;
  // As `units` and `value`, adding the fractions of a unit the items short of a whole portion would
  // yield if EVE reprocessed part portions (see `ItemRow.proRata`). Equal to them when nothing is left over.
  proRataUnits: Record<OptionKey, number>;
  proRataValue: Record<OptionKey, number>;
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
    // The same three, counting units short of a portion pro rata (see `ItemRow.proRata`).
    proRata: { options: Record<OptionKey, number>; mixed: Record<OptionKey, number>; fees: Record<OptionKey, number> };
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
  // What the units short of a portion would add, pro rata, per item and option.
  const shares = byOption((key) => items.map((item, i) => leftoverShare(item, stacks[key][i].leftover, yields[key], pricing.reprocessingTax)));
  const materialIds: number[] = [];
  const units = new Map<number, Record<OptionKey, number>>();
  const extra = new Map<number, Record<OptionKey, number>>();
  const add = (into: Map<number, Record<OptionKey, number>>, key: OptionKey, typeId: number, n: number) => {
    if (!units.has(typeId)) {
      units.set(typeId, byOption(() => 0));
      extra.set(typeId, byOption(() => 0));
      materialIds.push(typeId);
    }
    into.get(typeId)![key] += n;
  };
  for (const option of OPTIONS) {
    for (const stack of stacks[option.key]) for (const [typeId, n] of stack.materials) add(units, option.key, typeId, n);
  }
  for (const option of OPTIONS) {
    for (const share of shares[option.key]) for (const [typeId, n] of share) if (n > 0) add(extra, option.key, typeId, n);
  }
  const sales = new Map(materialIds.map((typeId) => [typeId, byOption((key) => saleValue(books[typeId], units.get(typeId)![key], pricing.basis))]));
  const unitPrice = new Map(
    materialIds.map((typeId) => [typeId, byOption((key) => (units.get(typeId)![key] > 0 ? sales.get(typeId)![key].value / units.get(typeId)![key] : 0))]),
  );
  // A pro-rata share is priced like the pile it would join; with no pile, at the best order.
  const shareOf = (typeId: number, key: OptionKey) => unitPrice.get(typeId)?.[key] || (topPrice(books[typeId], pricing.basis) ?? 0);

  const materials: MaterialRow[] = materialIds.map((typeId) => {
    const perOption = units.get(typeId)!;
    const more = extra.get(typeId)!;
    const sale = sales.get(typeId)!;
    return {
      typeId,
      name: appraisal.materialNames[typeId] ?? `Type ${typeId}`,
      units: perOption,
      value: byOption((key) => sale[key].value * kept),
      unitPrice: byOption((key) => (sale[key].sold > 0 ? sale[key].value / sale[key].sold : null)),
      topPrice: topPrice(books[typeId], pricing.basis),
      unpriced: OPTIONS.some((o) => (perOption[o.key] > 0 && sale[o.key].sold === 0) || (more[o.key] > 0 && shareOf(typeId, o.key) === 0)),
      partial: OPTIONS.some((o) => sale[o.key].sold > 0 && sale[o.key].sold < perOption[o.key]),
      proRataUnits: byOption((key) => perOption[key] + more[key]),
      proRataValue: byOption((key) => (sale[key].value + more[key] * shareOf(typeId, key)) * kept),
    };
  });

  const grossRows = items.map((item, i) => {
    const materialValue = (key: OptionKey) => {
      let value = 0;
      for (const [typeId, n] of stacks[key][i].materials) value += n * unitPrice.get(typeId)![key];
      return value;
    };
    const options = byOption((key) => (item.reprocess ? stacks[key][i].leftover * unitAsIs[i] + materialValue(key) : asIs[i].value));
    const leftover = item.reprocess ? stacks.base[i].leftover : 0;
    const proRata =
      leftover > 0
        ? byOption((key) => {
            let value = materialValue(key);
            for (const [typeId, n] of shares[key][i]) value += n * shareOf(typeId, key);
            return value;
          })
        : null;
    let best: ItemRow["best"] = "asIs";
    for (const option of OPTIONS) if (item.reprocess && options[option.key] > (best === "asIs" ? asIs[i].value : options[best])) best = option.key;
    return { asIs: asIs[i].value, options, proRata, best };
  });

  const rows: ItemRow[] = items.map((item, i) => ({
    typeId: item.typeId,
    name: item.name,
    quantity: item.quantity,
    reprocessable: item.reprocess !== null,
    oreSkill: item.reprocess?.oreSkill ?? null,
    portionSize: item.reprocess?.portionSize ?? 1,
    leftover: item.reprocess ? stacks.base[i].leftover : 0,
    asIs: grossRows[i].asIs * kept,
    options: byOption((key) => grossRows[i].options[key] * kept),
    proRata: grossRows[i].proRata && byOption((key) => grossRows[i].proRata![key] * kept),
    best: grossRows[i].best,
    unitPrice: asIs[i].sold > 0 ? unitAsIs[i] : null,
    topPrice: topPrice(books[item.typeId], pricing.basis),
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
  const proRata = byOption((key) => sum((row) => (row.proRata ?? row.options)[key]));
  return {
    items: rows,
    materials,
    totals: {
      ...totals,
      proRata: {
        options: proRata,
        mixed: byOption((key) => sum((row) => Math.max(row.asIs, (row.proRata ?? row.options)[key]))),
        fees: byOption((key) => fee(proRata[key])),
      },
      fees: { asIs: fee(totals.asIs), options: byOption((key) => fee(totals.options[key])) },
    },
  };
}
