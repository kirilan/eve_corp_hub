import type { Appraisal, Basis, Book, OptionKey, Result } from "./reprocess";
import { OPTIONS, saleValue } from "./reprocess";

/**
 * How long a sale takes, estimated from how fast a type has traded in the hub's region (ESI's daily
 * market history) and from the hub's order book. Pure, so the browser recomputes it with the basis.
 *
 * History counts every trade without saying which side made it, so the share that filled sell orders
 * (what a listing competes for) is read from where the recent average price sits between the top buy
 * and the lowest sell order: an average next to the sell price means most trades were buyers taking
 * sell orders. The rest filled buy orders, and that is the pace at which buy orders get used up and,
 * on a steady market, placed again.
 */

/** One day of `/markets/{region_id}/history`. */
export type EsiHistoryDay = { date: string; average: number; highest: number; lowest: number; order_count: number; volume: number };

/** A type's recent trading in a region: units a day over `PACE_DAYS`, and the recent average price. */
export type Pace = { volume: number; average: number | null };

export const PACE_DAYS = 30;
const PRICE_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
// Neither side ever gets all the trades; the clamp keeps one odd average from making a sale look endless.
const MIN_SHARE = 0.1;
const MAX_SHARE = 0.9;

/** History as the estimate uses it: the window ends yesterday, ESI's latest day, and quiet days count as none. */
export function paceFrom(days: EsiHistoryDay[], now: Date): Pace {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const within = (n: number) => days.filter((day) => today - Date.parse(`${day.date}T00:00:00Z`) <= n * DAY_MS);
  const month = within(PACE_DAYS);
  const vwap = (rows: EsiHistoryDay[]) => {
    const units = rows.reduce((sum, day) => sum + day.volume, 0);
    return units > 0 ? rows.reduce((sum, day) => sum + day.average * day.volume, 0) / units : null;
  };
  return {
    volume: month.reduce((sum, day) => sum + day.volume, 0) / PACE_DAYS,
    average: vwap(within(PRICE_DAYS)) ?? vwap(month),
  };
}

/** Share of the region's trades that filled sell orders; half when the book or the average cannot tell. */
export function sellShare(book: Book | undefined, average: number | null): number {
  const buy = book?.buy[0]?.[0];
  const sell = book?.sell[0]?.[0];
  if (average === null || buy === undefined || sell === undefined || sell <= buy) return 0.5;
  return Math.min(MAX_SHARE, Math.max(MIN_SHARE, (average - buy) / (sell - buy)));
}

export type SaleTime = {
  // Units the buy orders take at once; none when listing.
  now: number;
  // Days until the last unit has sold: 0 when it all goes at once, null with no trades to go by.
  days: number | null;
  // Selling now: ISK the stack fetches below every unit at the top buy price, and that as a share.
  depthCost: number;
  depth: number;
};

/**
 * Listing: you list just under the lowest sell order and stay there, and buyers come at the pace they
 * have been taking sell orders. Selling now: the buy orders take what they hold at once (walking down
 * the book, as the price does); the rest waits for new buy orders at the pace buyers have used them.
 */
export function saleTime(book: Book | undefined, pace: Pace | undefined, units: number, basis: Basis): SaleTime {
  if (units <= 0) return { now: 0, days: 0, depthCost: 0, depth: 0 };
  const share = sellShare(book, pace?.average ?? null);
  const perDay = (side: number) => (pace ? pace.volume * side : 0);
  if (basis === "sell") {
    const rate = perDay(share);
    return { now: 0, days: rate > 0 ? units / rate : null, depthCost: 0, depth: 0 };
  }
  const { value, sold } = saleValue(book, units, "buy");
  const top = book?.buy[0]?.[0] ?? 0;
  const depthCost = sold * top - value;
  const rest = units - sold;
  const rate = perDay(1 - share);
  return {
    now: sold,
    days: rest === 0 ? 0 : rate > 0 ? rest / rate : null,
    depthCost,
    depth: sold > 0 && top > 0 ? depthCost / (sold * top) : 0,
  };
}

export type ColumnKey = "asIs" | OptionKey;

export type TimeSummary = {
  // Days until 90% of the value has sold, and until all of it; null when what has no trades to go by
  // holds more than the rest.
  most: number | null;
  all: number | null;
  // What sells last, when that takes any time.
  slowest: string | null;
  // Selling now: share of the value the buy orders take at once, and what walking down them costs, after tax.
  nowShare: number;
  depthCost: number;
  // Types with value but no trades in the region over the last 30 days.
  noTrades: string[];
  // Value at the basis's price of what has one; 0 when nothing does, and then there is nothing to estimate.
  value: number;
};

/** What each column sells, per type: the items as they are, or the materials plus what is not reprocessed. */
export function columnPiles(result: Result): Record<ColumnKey, Map<number, number>> {
  const pile = () => new Map<number, number>();
  const piles = { asIs: pile(), ...Object.fromEntries(OPTIONS.map((option) => [option.key, pile()])) } as Record<ColumnKey, Map<number, number>>;
  const add = (key: ColumnKey, typeId: number, units: number) => {
    if (units > 0) piles[key].set(typeId, (piles[key].get(typeId) ?? 0) + units);
  };
  for (const row of result.items) {
    add("asIs", row.typeId, row.quantity);
    for (const option of OPTIONS) add(option.key, row.typeId, row.reprocessable ? row.leftover : row.quantity);
  }
  for (const material of result.materials) for (const option of OPTIONS) add(option.key, material.typeId, material.units[option.key]);
  return piles;
}

const SHARE_FOR_MOST = 0.9;

/**
 * How long each column takes to sell, weighting each type by its value at the price the basis uses
 * (the lowest sell order, or the top buy order), so a pile of cheap leftovers does not hide that the
 * valuable part sells in a day.
 */
export function timeSummaries(appraisal: Appraisal, result: Result, basis: Basis, kept: number): Record<ColumnKey, TimeSummary> {
  const names = new Map<number, string>([
    ...Object.entries(appraisal.materialNames).map(([id, name]) => [Number(id), name] as const),
    ...appraisal.items.map((item) => [item.typeId, item.name] as const),
  ]);
  const piles = columnPiles(result);
  const summarise = (pile: Map<number, number>): TimeSummary => {
    const entries = [...pile].flatMap(([typeId, units]) => {
      const book = appraisal.books[typeId];
      const price = (basis === "sell" ? book?.sell[0]?.[0] : book?.buy[0]?.[0]) ?? 0;
      if (price <= 0) return [];
      const time = saleTime(book, appraisal.pace[typeId], units, basis);
      return [{ name: names.get(typeId) ?? `Type ${typeId}`, weight: units * price, now: time.now * price, time }];
    });
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
    const days = (entry: (typeof entries)[number]) => entry.time.days ?? Infinity;
    const sorted = [...entries].sort((a, b) => days(a) - days(b));
    let most = 0;
    let running = 0;
    for (const entry of sorted) {
      most = days(entry);
      running += entry.weight;
      if (running >= SHARE_FOR_MOST * total) break;
    }
    const last = sorted.at(-1);
    const finite = (n: number) => (Number.isFinite(n) ? n : null);
    return {
      most: finite(most),
      all: last ? finite(days(last)) : 0,
      slowest: last && days(last) > 0 ? last.name : null,
      nowShare: basis === "buy" && total > 0 ? entries.reduce((sum, entry) => sum + entry.now, 0) / total : 0,
      depthCost: entries.reduce((sum, entry) => sum + entry.time.depthCost, 0) * kept,
      noTrades: entries.filter((entry) => entry.time.days === null).map((entry) => entry.name),
      value: total,
    };
  };
  return Object.fromEntries(Object.entries(piles).map(([key, pile]) => [key, summarise(pile)])) as Record<ColumnKey, TimeSummary>;
}

/** "at once", "~5 hours", "~3 days", "~2 weeks", "~4 months", "over a year"; null as "no recent trades". */
export function formatDays(days: number | null): string {
  if (days === null) return "no recent trades";
  if (days === 0) return "at once";
  if (days < 1 / 24) return "within the hour";
  if (days < 1) return `~${Math.ceil(days * 24)} hour${Math.ceil(days * 24) === 1 ? "" : "s"}`;
  if (days < 1.5) return "~1 day";
  if (days < 14) return `~${Math.round(days)} days`;
  if (days < 60) return `~${Math.round(days / 7)} weeks`;
  if (days < 365) return `~${Math.round(days / 30)} months`;
  return "over a year";
}
