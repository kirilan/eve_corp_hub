import "server-only";
import { and, arrayContains, asc, eq, inArray, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { characters, marketPrices, marketSnapshots, type PriceLevel } from "@/db/schema";
import { characterAccessToken, ConsentMissingError } from "@/lib/auth/tokens";
import { EsiError, esiPages } from "@/lib/eve/esi";
import { FEATURE_SCOPES } from "@/lib/eve/sso";
import { HUBS, type Hub } from "./hubs";
import type { Book } from "./reprocess";

/**
 * Order books at the trade hubs, cached in `market_prices`. Jita's come from the public regional feed,
 * one type at a time, as the calculator asks for them. A player structure's market is not in that
 * feed: it is read whole with the token of a character that can dock there and allows market reading.
 * Anyone's such character will do, since market data is the same for everyone.
 */

// ESI caches order books for 5 minutes; a reprocessing decision does not need them fresher than this.
export const PRICE_MAX_AGE_MS = 15 * 60 * 1000;
// A structure read in progress, or one that just failed, holds off other requests for this long.
const LEASE_MS = 2 * 60 * 1000;
const LEVELS = 50;
const FETCH_CONCURRENCY = 10;
// Stop asking once this many types fail: ESI is down, and its error limit is shared by the whole site.
const MAX_FAILURES = 5;
// 1000 orders a page; a busy structure market runs to tens of thousands.
const STRUCTURE_MAX_PAGES = 200;
const READER_TRIES = 3;

export type EsiOrder = { type_id: number; location_id: number; is_buy_order: boolean; price: number; volume_remain: number };

export type HubPrices = {
  books: Map<number, Book>;
  // Oldest price used; null when there were none.
  asOf: Date | null;
  // False when the hub's market could not be read at all (no prices, not just no orders).
  available: boolean;
  warnings: string[];
};

const EMPTY: Book = { buy: [], sell: [] };

/** Each type's order book at one location: units summed per price, the best LEVELS prices per side. */
export function booksFrom(orders: EsiOrder[], locationId: number): Map<number, Book> {
  const sides = new Map<number, { buy: Map<number, number>; sell: Map<number, number> }>();
  for (const order of orders) {
    if (order.location_id !== locationId || order.volume_remain <= 0) continue;
    let type = sides.get(order.type_id);
    if (!type) sides.set(order.type_id, (type = { buy: new Map(), sell: new Map() }));
    const side = order.is_buy_order ? type.buy : type.sell;
    side.set(order.price, (side.get(order.price) ?? 0) + order.volume_remain);
  }
  const levels = (side: Map<number, number>, direction: 1 | -1): PriceLevel[] =>
    [...side].sort((a, b) => direction * (a[0] - b[0])).slice(0, LEVELS);
  return new Map([...sides].map(([typeId, type]) => [typeId, { buy: levels(type.buy, -1), sell: levels(type.sell, 1) }]));
}

async function inBatches<T, R>(values: T[], size: number, run: (value: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < values.length; i += size) out.push(...(await Promise.all(values.slice(i, i + size).map(run))));
  return out;
}

function oldest(dates: Date[]): Date | null {
  return dates.length === 0 ? null : new Date(Math.min(...dates.map((date) => date.getTime())));
}

const eveTime = (date: Date) => `${date.toISOString().slice(0, 16).replace("T", " ")} EVE`;

/** Order books for these types at a hub, reading the market where the cache is stale. */
export async function hubPrices(hub: Hub, typeIds: number[], viewerId: string): Promise<HubPrices> {
  const wanted = [...new Set(typeIds)];
  return HUBS[hub].structure ? structurePrices(hub, wanted, viewerId) : regionPrices(hub, wanted);
}

async function cachedRows(locationId: number, typeIds: number[]) {
  if (typeIds.length === 0) return [];
  return db
    .select()
    .from(marketPrices)
    .where(and(eq(marketPrices.locationId, locationId), inArray(marketPrices.typeId, typeIds)));
}

async function regionPrices(hub: Hub, typeIds: number[]): Promise<HubPrices> {
  const { locationId, regionId } = HUBS[hub];
  const known = new Map((await cachedRows(locationId, typeIds)).map((row) => [row.typeId, row]));
  const cutoff = Date.now() - PRICE_MAX_AGE_MS;
  const stale = typeIds.filter((typeId) => (known.get(typeId)?.fetchedAt.getTime() ?? 0) < cutoff);

  let failures = 0;
  const fetched = await inBatches(stale, FETCH_CONCURRENCY, async (typeId) => {
    if (failures >= MAX_FAILURES) return null;
    try {
      const orders = await esiPages<EsiOrder>(`/markets/${regionId}/orders?order_type=all&type_id=${typeId}`);
      // Only orders in the hub station itself: region-wide buy orders elsewhere rarely pay better.
      return { locationId, typeId, ...(booksFrom(orders, locationId).get(typeId) ?? EMPTY), fetchedAt: new Date() };
    } catch (error) {
      failures++;
      console.warn(`market read failed for type ${typeId} at ${hub}`, error);
      return null;
    }
  });
  const fresh = fetched.filter((row) => row !== null);
  if (fresh.length > 0) {
    await db
      .insert(marketPrices)
      .values(fresh)
      .onConflictDoUpdate({
        target: [marketPrices.locationId, marketPrices.typeId],
        set: { buy: sql`excluded.buy`, sell: sql`excluded.sell`, fetchedAt: sql`excluded.fetched_at` },
      });
    for (const row of fresh) known.set(row.typeId, row);
  }

  const warnings: string[] = [];
  const missed = stale.length - fresh.length;
  if (missed > 0) {
    const older = stale.filter((typeId) => known.has(typeId) && !fresh.some((row) => row.typeId === typeId)).length;
    warnings.push(
      `EVE's market did not answer for ${missed} item${missed === 1 ? "" : "s"}` +
        (older > 0 ? `; ${older} of them use older prices` : "") +
        (missed > older ? `; ${missed - older} have no price` : "") +
        ". Try again in a moment.",
    );
  }
  const rows = [...known.values()];
  return {
    books: new Map(rows.map((row) => [row.typeId, { buy: row.buy, sell: row.sell }])),
    asOf: oldest(rows.map((row) => row.fetchedAt)),
    available: rows.length > 0 || typeIds.length === 0,
    warnings,
  };
}

async function structurePrices(hub: Hub, typeIds: number[], viewerId: string): Promise<HubPrices> {
  const { locationId, label } = HUBS[hub];
  const snapshot = async () => (await db.select().from(marketSnapshots).where(eq(marketSnapshots.locationId, locationId)))[0];
  let current = await snapshot();
  let outcome: ReadOutcome | null = null;
  if (!current?.fetchedAt || current.fetchedAt.getTime() < Date.now() - PRICE_MAX_AGE_MS) {
    outcome = await readStructureMarket(hub, viewerId);
    current = await snapshot();
  }

  if (!current?.fetchedAt) {
    // Busy means another request holds the lease: reading right now, or a read that failed moments ago.
    const why =
      outcome?.status === "failed"
        ? `No ${label} prices yet: ${outcome.error}.`
        : current?.error
          ? `No ${label} prices yet: ${current.error}. The market is tried again at most every two minutes.`
          : `${label}'s market is being read right now; try again in a minute.`;
    return { books: new Map(), asOf: null, available: false, warnings: [why] };
  }

  const warnings: string[] = [];
  if (outcome?.status === "failed") warnings.push(`Could not read ${label}'s market now (${outcome.error}); prices are from ${eveTime(current.fetchedAt)}.`);
  const rows = new Map((await cachedRows(locationId, typeIds)).map((row) => [row.typeId, row]));
  // The structure's whole market was read, so a type with no row has no orders there.
  const books = new Map(typeIds.map((typeId) => [typeId, rows.has(typeId) ? { buy: rows.get(typeId)!.buy, sell: rows.get(typeId)!.sell } : EMPTY]));
  return { books, asOf: current.fetchedAt, available: true, warnings };
}

type Reader = { id: number; userId: string; name: string };

/** Characters that allow market reading: the last one that worked, then the viewer's own, then anyone's. */
async function marketReaders(viewerId: string, lastReader: number | null): Promise<Reader[]> {
  return db
    .select({ id: characters.id, userId: characters.userId, name: characters.name })
    .from(characters)
    .where(arrayContains(characters.scopes, [...FEATURE_SCOPES.markets]))
    .orderBy(sql`${characters.id} = ${lastReader ?? 0} desc`, sql`${characters.userId} = ${viewerId} desc`, asc(characters.id))
    .limit(READER_TRIES);
}

type ReadOutcome = { status: "read"; orders: number } | { status: "busy" } | { status: "failed"; error: string };

function readError(error: unknown, reader: Reader, label: string): string {
  if (error instanceof ConsentMissingError) return `${reader.name} no longer allows market reading`;
  if (error instanceof EsiError && error.status === 403) return `${reader.name} may not use the ${label} market (no docking access?)`;
  return error instanceof Error ? error.message : String(error);
}

/**
 * Reads a structure's whole market and replaces its cached prices. Concurrent requests read it once:
 * the first takes a short lease on the snapshot row, the others keep using the prices already there.
 */
export async function readStructureMarket(hub: Hub, viewerId: string): Promise<ReadOutcome> {
  const { locationId, label } = HUBS[hub];
  const now = new Date();
  await db.insert(marketSnapshots).values({ locationId, attemptedAt: new Date(0) }).onConflictDoNothing();
  const [claimed] = await db
    .update(marketSnapshots)
    .set({ attemptedAt: now })
    .where(and(eq(marketSnapshots.locationId, locationId), lt(marketSnapshots.attemptedAt, new Date(now.getTime() - LEASE_MS))))
    .returning();
  if (!claimed) return { status: "busy" };

  const readers = await marketReaders(viewerId, claimed.readerCharacterId);
  let error = "no character allows market reading; one that can dock there must allow it on the Characters page";
  for (const reader of readers) {
    try {
      const token = await characterAccessToken(reader.userId, reader.id, "markets");
      const orders = await esiPages<EsiOrder>(`/markets/structures/${locationId}`, { token, maxPages: STRUCTURE_MAX_PAGES });
      const rows = [...booksFrom(orders, locationId)].map(([typeId, book]) => ({ locationId, typeId, ...book, fetchedAt: now }));
      await db.transaction(async (tx) => {
        await tx.delete(marketPrices).where(eq(marketPrices.locationId, locationId));
        for (let i = 0; i < rows.length; i += 1000) await tx.insert(marketPrices).values(rows.slice(i, i + 1000));
        await tx
          .update(marketSnapshots)
          .set({ fetchedAt: now, readerCharacterId: reader.id, orders: orders.length, error: null })
          .where(eq(marketSnapshots.locationId, locationId));
      });
      return { status: "read", orders: orders.length };
    } catch (failure) {
      error = readError(failure, reader, label);
      if (!(failure instanceof ConsentMissingError || failure instanceof EsiError)) console.warn(`market read of ${hub} failed`, failure);
    }
  }
  await db.update(marketSnapshots).set({ error }).where(eq(marketSnapshots.locationId, locationId));
  return { status: "failed", error };
}

export type StructureMarketStatus = {
  readAt: Date | null;
  error: string | null;
  // Characters on the site that allow market reading, and how many of them are the viewer's.
  readers: number;
  ownReaders: number;
};

/** For the calculator page: when the structure's market was last read, and who could read it. */
export async function structureMarketStatus(hub: Hub, viewerId: string): Promise<StructureMarketStatus> {
  const [snapshot] = await db.select().from(marketSnapshots).where(eq(marketSnapshots.locationId, HUBS[hub].locationId));
  const [counts] = await db
    .select({
      readers: sql<number>`count(*)::int`,
      ownReaders: sql<number>`(count(*) FILTER (WHERE ${characters.userId} = ${viewerId}))::int`,
    })
    .from(characters)
    .where(arrayContains(characters.scopes, [...FEATURE_SCOPES.markets]));
  return { readAt: snapshot?.fetchedAt ?? null, error: snapshot?.error ?? null, readers: counts.readers, ownReaders: counts.ownReaders };
}
