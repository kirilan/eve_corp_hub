import "server-only";
import { and, eq, gte, inArray, isNotNull, lt, min, sum } from "drizzle-orm";
import { db } from "@/db";
import { characters, tradeExclusions, walletEntries, walletTransactions } from "@/db/schema";
import { categoryNames } from "@/lib/eve/categories";
import { averagePrices } from "@/lib/eve/prices";
import { typesById } from "@/lib/eve/types";
import { bucketOf, bucketsBetween, type Grouping } from "@/lib/income/report";
import { addSale, emptyFigures, type Holding, holdings, matchTrades, type Sale, type SaleFigures, type Trade } from "./fifo";

/**
 * Trade performance for the income page: profit per sale from the profile's market transactions
 * (see `fifo.ts`), rolled up per chart bucket, item category and item, and the stock bought and not
 * sold yet. Purchases are matched across every character of the profile whatever the filter; the
 * character filter picks whose sales (and whose unsold purchases) are shown.
 */

// Journal lines that are sales tax on one market transaction.
const SALES_TAX_REF_TYPES = ["transaction_tax", "market_provider_tax"];

// Items with no category on record (types stored before categories were kept).
export const NO_CATEGORY = -1;

export type TradeScope = {
  from: string;
  to: string;
  grouping: Grouping;
  // Empty means every character.
  characterIds: number[];
  // A chart bucket to look into, or null for the whole range.
  at: string | null;
};

export type ItemRow = SaleFigures & { typeId: number; name: string; categoryId: number };
export type CategoryRow = SaleFigures & { categoryId: number; name: string; items: number };

// Per chart bucket, per category: profit from items that made money in that bucket, and the loss
// from items that lost money, as positive amounts.
export type TradeBucket = { key: string; profit: number; gains: Record<number, number>; losses: Record<number, number> };

export type HoldingRow = Holding & {
  name: string;
  categoryId: number;
  // Units at EVE's average price; null when EVE has no price for the type.
  value: number | null;
};

export type TradeReport = {
  // When the report was made, for the age of unsold stock.
  asOf: Date;
  // Earliest stored transaction of the profile: trades before it are unknown.
  trackedSince: Date | null;
  categoryNames: Record<number, string>;
  // The whole range, for the chart.
  buckets: TradeBucket[];
  rangeTotals: SaleFigures;
  // The range, or the bucket looked into.
  scope: { from: string; to: string; at: string | null };
  totals: SaleFigures & { brokerFees: number };
  items: ItemRow[];
  categories: CategoryRow[];
  holdings: HoldingRow[];
  excluded: { typeId: number; name: string }[];
};

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The last day of the bucket starting on `key`. */
export function bucketEnd(key: string, grouping: Grouping): string {
  if (grouping === "day") return key;
  if (grouping === "week") return addDays(key, 6);
  const next = new Date(`${key}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  return addDays(next.toISOString().slice(0, 10), -1);
}

const dayOf = (date: Date) => date.toISOString().slice(0, 10);

/** Rolls sales up for the chart and the tables. Pure: names and categories are looked up by the caller. */
export function summarise(sales: Sale[], scope: TradeScope, categoryOf: (typeId: number) => number) {
  const shown = (sale: Sale) => scope.characterIds.length === 0 || scope.characterIds.includes(sale.characterId);
  const buckets = new Map(bucketsBetween(scope.from, scope.to, scope.grouping).map((key) => [key, new Map<number, number>()]));
  const rangeTotals = emptyFigures();
  const from = scope.at ?? scope.from;
  const to = scope.at ? bucketEnd(scope.at, scope.grouping) : scope.to;
  const totals = emptyFigures();
  const items = new Map<number, SaleFigures>();
  for (const sale of sales) {
    const day = dayOf(sale.date);
    if (day < scope.from || day > scope.to || !shown(sale)) continue;
    addSale(rangeTotals, sale);
    // Profit per item per bucket, to split each bucket into what made and what lost money.
    const perType = buckets.get(bucketOf(day, scope.grouping));
    perType?.set(sale.typeId, (perType.get(sale.typeId) ?? 0) + sale.profit);
    if (day < from || day > to) continue;
    addSale(totals, sale);
    let item = items.get(sale.typeId);
    if (!item) items.set(sale.typeId, (item = emptyFigures()));
    addSale(item, sale);
  }
  const chart: TradeBucket[] = [...buckets].map(([key, perType]) => {
    const bucket: TradeBucket = { key, profit: 0, gains: {}, losses: {} };
    for (const [typeId, profit] of perType) {
      const category = categoryOf(typeId);
      bucket.profit += profit;
      if (profit > 0) bucket.gains[category] = (bucket.gains[category] ?? 0) + profit;
      else if (profit < 0) bucket.losses[category] = (bucket.losses[category] ?? 0) - profit;
    }
    return bucket;
  });
  return { buckets: chart, rangeTotals, totals, items, from, to };
}

/** Every market transaction of the profile, with the sales tax on each sale, minus trades between its own characters and excluded items. */
async function profileTrades(userId: string): Promise<{ trades: Trade[]; excluded: number[] }> {
  const own = (await db.select({ id: characters.id }).from(characters).where(eq(characters.userId, userId))).map((c) => c.id);
  const excluded = (await db.select({ typeId: tradeExclusions.typeId }).from(tradeExclusions).where(eq(tradeExclusions.userId, userId))).map(
    (row) => row.typeId,
  );
  if (own.length === 0) return { trades: [], excluded };
  const [rows, taxes] = await Promise.all([
    db.select().from(walletTransactions).where(inArray(walletTransactions.characterId, own)),
    db
      .select({ transactionId: walletEntries.transactionId, amount: sum(walletEntries.amount).mapWith(Number) })
      .from(walletEntries)
      .where(
        and(
          inArray(walletEntries.characterId, own),
          isNotNull(walletEntries.transactionId),
          // The sale's own journal line names the same transaction: only the tax lines count.
          inArray(walletEntries.refType, SALES_TAX_REF_TYPES),
        ),
      )
      .groupBy(walletEntries.transactionId),
  ]);
  const taxOf = new Map(taxes.map((row) => [row.transactionId!, -row.amount]));
  const ownIds = new Set(own);
  const skip = new Set(excluded);
  const trades = rows
    .filter((row) => !ownIds.has(row.clientId) && !skip.has(row.typeId))
    .map((row) => ({
      characterId: row.characterId,
      transactionId: row.transactionId,
      date: row.date,
      typeId: row.typeId,
      quantity: row.quantity,
      unitPrice: row.unitPrice,
      isBuy: row.isBuy,
      tax: row.isBuy ? 0 : Math.max(0, taxOf.get(row.transactionId) ?? 0),
    }));
  return { trades, excluded };
}

async function brokerFees(userId: string, characterIds: number[], from: string, to: string): Promise<number> {
  const [row] = await db
    .select({ amount: sum(walletEntries.amount).mapWith(Number) })
    .from(walletEntries)
    .innerJoin(characters, eq(characters.id, walletEntries.characterId))
    .where(
      and(
        eq(characters.userId, userId),
        eq(walletEntries.refType, "brokers_fee"),
        gte(walletEntries.date, new Date(`${from}T00:00:00Z`)),
        lt(walletEntries.date, new Date(`${addDays(to, 1)}T00:00:00Z`)),
        characterIds.length > 0 ? inArray(walletEntries.characterId, characterIds) : undefined,
      ),
    );
  return -(row?.amount ?? 0);
}

async function firstTransaction(userId: string): Promise<Date | null> {
  const [row] = await db
    .select({ date: min(walletTransactions.date) })
    .from(walletTransactions)
    .innerJoin(characters, eq(characters.id, walletTransactions.characterId))
    .where(eq(characters.userId, userId));
  return row?.date ?? null;
}

export async function tradeReport(userId: string, scope: TradeScope): Promise<TradeReport> {
  const [{ trades, excluded }, trackedSince] = await Promise.all([profileTrades(userId), firstTransaction(userId)]);
  const { sales, lots } = matchTrades(trades);
  const shownLots = lots.filter((lot) => scope.characterIds.length === 0 || scope.characterIds.includes(lot.characterId));
  const held = holdings(shownLots);

  const inRange = sales.filter((sale) => {
    const day = dayOf(sale.date);
    return day >= scope.from && day <= scope.to;
  });
  const types = await typesById([...new Set([...inRange.map((s) => s.typeId), ...held.map((h) => h.typeId), ...excluded])]);
  const categoryOf = (typeId: number) => types.get(typeId)?.categoryId ?? NO_CATEGORY;
  const nameOf = (typeId: number) => types.get(typeId)?.name ?? `Type ${typeId}`;

  const summary = summarise(inRange, scope, categoryOf);
  const items: ItemRow[] = [...summary.items].map(([typeId, figures]) => ({ ...figures, typeId, name: nameOf(typeId), categoryId: categoryOf(typeId) }));
  // Every category of the range (the chart shows them all), not only of the bucket looked into.
  const categoryIds = [...new Set([...inRange.map((s) => categoryOf(s.typeId)), ...held.map((h) => categoryOf(h.typeId))])];
  const names = await categoryNames(categoryIds.filter((id) => id !== NO_CATEGORY));
  names[NO_CATEGORY] = "Uncategorised";

  const byCategory = new Map<number, CategoryRow>();
  for (const item of items) {
    let row = byCategory.get(item.categoryId);
    if (!row) byCategory.set(item.categoryId, (row = { ...emptyFigures(), categoryId: item.categoryId, name: names[item.categoryId], items: 0 }));
    for (const key of Object.keys(emptyFigures()) as (keyof SaleFigures)[]) row[key] += item[key];
    row.items++;
  }

  const prices = held.length > 0 ? await averagePrices() : {};
  return {
    asOf: new Date(),
    trackedSince,
    categoryNames: names,
    buckets: summary.buckets,
    rangeTotals: summary.rangeTotals,
    scope: { from: summary.from, to: summary.to, at: scope.at },
    totals: { ...summary.totals, brokerFees: await brokerFees(userId, scope.characterIds, summary.from, summary.to) },
    items: items.sort((a, b) => b.profit - a.profit),
    categories: [...byCategory.values()].sort((a, b) => b.profit - a.profit),
    holdings: held
      .map((h) => ({
        ...h,
        name: nameOf(h.typeId),
        categoryId: categoryOf(h.typeId),
        value: prices[h.typeId] ? prices[h.typeId] * h.quantity : null,
      }))
      .sort((a, b) => b.cost - a.cost),
    excluded: excluded.map((typeId) => ({ typeId, name: nameOf(typeId) })).sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Keeps an item out of trade performance, or brings it back. */
export async function setTradeExclusion(userId: string, typeId: number, excluded: boolean): Promise<void> {
  if (!Number.isSafeInteger(typeId) || typeId <= 0) throw new Error("not an item type");
  if (excluded) await db.insert(tradeExclusions).values({ userId, typeId }).onConflictDoNothing();
  else await db.delete(tradeExclusions).where(and(eq(tradeExclusions.userId, userId), eq(tradeExclusions.typeId, typeId)));
}
