/**
 * Where an open order stands in its station's book, and EVE's price ticks. Pure; the same rules as
 * eve-skills' `orders --check` (pricing.py), so both tools call an order undercut at the same point.
 */

import type { PriceLevel } from "@/db/schema";

// A leading block of the sell book is a "sliver", ignored rather than undercut, when it is thin on the
// market and next to our own stack, and clearly cheaper than the order after it. Undercutting a
// one-unit bait order gives away the gap on every unit listed; ignoring it only costs the minutes
// that unit takes to sell. eve-skills' defaults, from its Jita pricing rounds of 2026-09-27.
const THIN_UNITS = 5; // a sliver may hold this many units ...
const THIN_PCT = 2; // ... or this percent of the regional daily volume, whichever is more,
const STACK_PCT = 10; // but never more than this percent of the stack being priced,
const GAP_PCT = 2; // and the next order must sit more than this percent above it.

/** EVE's price step at `price`: prices carry at most four significant digits, 0.01 at least. */
export function tick(price: number): number {
  if (price <= 0) return 0.01;
  return Math.max(0.01, 10 ** (Math.floor(Math.log10(price)) - 3));
}

const cents = (value: number) => Math.round(value * 100) / 100;

/** The next valid price under `price` (3,325,000 -> 3,324,000; 1,000,000 -> 999,000). */
export function tickBelow(price: number): number {
  return Math.max(0.01, cents(price - tick(price)));
}

/** The next valid price over `price` (1,149,000 -> 1,150,000; 999,900 -> 1,000,000). */
export function tickAbove(price: number): number {
  return cents(price + tick(price));
}

/**
 * Index of the first real level in a cheapest-first, competitors-only sell book: a leading block is
 * skipped when it holds at most max(THIN_UNITS, THIN_PCT% of daily volume) units, and at most
 * STACK_PCT% of our `quantity` (one unit at least), and the next level is more than GAP_PCT% above
 * it. The longest such block wins.
 */
export function realFloor(sells: PriceLevel[], perDay: number, quantity: number): number {
  const cap = Math.min(Math.max(THIN_UNITS, (perDay * THIN_PCT) / 100), Math.max(1, (quantity * STACK_PCT) / 100));
  let best = 0;
  let volume = 0;
  for (let k = 1; k < sells.length; k++) {
    volume += sells[k - 1][1];
    if (volume > cap) break;
    if (sells[k][0] > sells[k - 1][0] * (1 + GAP_PCT / 100)) best = k;
  }
  return best;
}

export type Status = "cheapest" | "undercut" | "behind sliver" | "top" | "outbid" | "alone";

export type Standing = {
  status: Status;
  // The best competing price on the order's side, null with no competition.
  bestOther: number | null;
  // Competing units priced ahead of the order, and how many days of the region's trade they are.
  unitsAhead: number;
  daysAhead: number | null;
  // A price that would put the order in front; null when it is there, or only a sliver is ahead.
  suggest: number | null;
};

/**
 * One order against the competing levels on its side of its station's book, best first (the
 * profile's own orders already taken out). `perDay` is the region's units traded per day.
 */
export function standing(isBuy: boolean, price: number, remain: number, others: PriceLevel[], perDay: number | null): Standing {
  const pace = perDay ?? 0;
  if (others.length === 0) return { status: "alone", bestOther: null, unitsAhead: 0, daysAhead: pace ? 0 : null, suggest: null };
  const ahead = others.filter(([level]) => (isBuy ? level > price : level < price));
  const unitsAhead = ahead.reduce((sum, [, units]) => sum + units, 0);
  const base = { bestOther: others[0][0], unitsAhead, daysAhead: pace ? unitsAhead / pace : null };
  if (isBuy) return { ...base, status: ahead.length > 0 ? "outbid" : "top", suggest: ahead.length > 0 ? tickAbove(others[0][0]) : null };
  if (ahead.length === 0) return { ...base, status: "cheapest", suggest: null };
  const target = tickBelow(others[realFloor(others, pace, remain)][0]);
  return target < price ? { ...base, status: "undercut", suggest: target } : { ...base, status: "behind sliver", suggest: null };
}

/**
 * One side of a book with the profile's own orders taken out: each own order's remaining units come
 * off the level at its price, so a sibling order never counts as competition.
 */
export function competitors(levels: PriceLevel[], own: { price: number; remain: number }[]): PriceLevel[] {
  const mine = new Map<number, number>();
  for (const order of own) mine.set(order.price, (mine.get(order.price) ?? 0) + order.remain);
  return levels
    .map(([price, units]): PriceLevel => [price, units - (mine.get(price) ?? 0)])
    .filter(([, units]) => units > 0);
}
