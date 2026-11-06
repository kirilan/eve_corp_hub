/**
 * Trade profit from market transactions, first in, first out. Pure.
 *
 * Every purchase is a lot; a sale takes units from the oldest lots of that item, across all of the
 * profile's characters (buying on one alt and selling on another is still one trade). A sale's
 * profit is what its matched units sold for, less what they were bought for and the sales tax on
 * them. Units sold with no purchase on record (loot, things built, or bought before tracking began)
 * have no known cost: they are counted apart rather than as pure profit. What is left in the lots
 * at the end is stock bought and not sold yet.
 *
 * Broker fees are not per item: they are charged when an order is placed or changed, whether or not
 * it sells. They are shown against trade profit as a whole, not against any one sale.
 */

export type Trade = {
  characterId: number;
  transactionId: number;
  date: Date;
  typeId: number;
  quantity: number;
  unitPrice: number;
  isBuy: boolean;
  // Sales tax charged on this sale, as a positive amount; 0 for purchases and when unknown.
  tax: number;
};

export type Sale = {
  characterId: number;
  typeId: number;
  date: Date;
  quantity: number;
  revenue: number;
  tax: number;
  // Units that came from a recorded purchase, what they sold for, and what they cost.
  matched: number;
  matchedRevenue: number;
  cost: number;
  // matchedRevenue - cost - the sales tax on the matched units.
  profit: number;
};

export type Lot = { characterId: number; typeId: number; date: Date; quantity: number; unitPrice: number };

export type Matched = { sales: Sale[]; lots: Lot[] };

/** Matches sales to purchases, oldest first. Purchases sort before sales at the same moment. */
export function matchTrades(trades: Trade[]): Matched {
  const ordered = [...trades].sort(
    (a, b) => a.date.getTime() - b.date.getTime() || Number(b.isBuy) - Number(a.isBuy) || a.transactionId - b.transactionId,
  );
  const open = new Map<number, Lot[]>();
  const sales: Sale[] = [];
  for (const trade of ordered) {
    if (trade.quantity <= 0) continue;
    let lots = open.get(trade.typeId);
    if (!lots) open.set(trade.typeId, (lots = []));
    if (trade.isBuy) {
      lots.push({ characterId: trade.characterId, typeId: trade.typeId, date: trade.date, quantity: trade.quantity, unitPrice: trade.unitPrice });
      continue;
    }
    let left = trade.quantity;
    let cost = 0;
    while (left > 0 && lots.length > 0) {
      const lot = lots[0];
      const take = Math.min(left, lot.quantity);
      cost += take * lot.unitPrice;
      lot.quantity -= take;
      left -= take;
      if (lot.quantity === 0) lots.shift();
    }
    const matched = trade.quantity - left;
    const revenue = trade.quantity * trade.unitPrice;
    const matchedRevenue = matched * trade.unitPrice;
    const matchedTax = trade.tax * (matched / trade.quantity);
    sales.push({
      characterId: trade.characterId,
      typeId: trade.typeId,
      date: trade.date,
      quantity: trade.quantity,
      revenue,
      tax: trade.tax,
      matched,
      matchedRevenue,
      cost,
      profit: matched > 0 ? matchedRevenue - cost - matchedTax : 0,
    });
  }
  return { sales, lots: [...open.values()].flat() };
}

/** Figures for a set of sales: an item, a category, a day. */
export type SaleFigures = {
  sold: number;
  revenue: number;
  tax: number;
  matched: number;
  matchedRevenue: number;
  cost: number;
  profit: number;
  // Units and revenue with no purchase on record.
  unmatched: number;
  unmatchedRevenue: number;
};

export const emptyFigures = (): SaleFigures => ({
  sold: 0,
  revenue: 0,
  tax: 0,
  matched: 0,
  matchedRevenue: 0,
  cost: 0,
  profit: 0,
  unmatched: 0,
  unmatchedRevenue: 0,
});

export function addSale(into: SaleFigures, sale: Sale): SaleFigures {
  into.sold += sale.quantity;
  into.revenue += sale.revenue;
  into.tax += sale.tax;
  into.matched += sale.matched;
  into.matchedRevenue += sale.matchedRevenue;
  into.cost += sale.cost;
  into.profit += sale.profit;
  into.unmatched += sale.quantity - sale.matched;
  into.unmatchedRevenue += sale.revenue - sale.matchedRevenue;
  return into;
}

/** Profit as a share of what the matched units sold for; null with nothing matched. */
export function margin(figures: SaleFigures): number | null {
  return figures.matchedRevenue > 0 ? figures.profit / figures.matchedRevenue : null;
}

export type Holding = {
  typeId: number;
  quantity: number;
  cost: number;
  oldest: Date;
  newest: Date;
};

/** Unsold lots per item: units, what they cost, and when the oldest and newest were bought. */
export function holdings(lots: Lot[]): Holding[] {
  const byType = new Map<number, Holding>();
  for (const lot of lots) {
    if (lot.quantity <= 0) continue;
    const held = byType.get(lot.typeId);
    if (!held) {
      byType.set(lot.typeId, { typeId: lot.typeId, quantity: lot.quantity, cost: lot.quantity * lot.unitPrice, oldest: lot.date, newest: lot.date });
      continue;
    }
    held.quantity += lot.quantity;
    held.cost += lot.quantity * lot.unitPrice;
    if (lot.date < held.oldest) held.oldest = lot.date;
    if (lot.date > held.newest) held.newest = lot.date;
  }
  return [...byType.values()];
}
