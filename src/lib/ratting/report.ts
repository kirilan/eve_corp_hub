import "server-only";
import { and, asc, desc, eq, gte, inArray, isNotNull, sql, sum } from "drizzle-orm";
import { db } from "@/db";
import { characters, rattingEntries, walletSyncs } from "@/db/schema";
import { hasFeature } from "@/lib/eve/sso";
import { RATTING_REF_TYPES, SOURCES, sourceOf, type Source } from "./sources";

/**
 * The ratting tracker's numbers. Everything is per UTC day (EVE time), read from the database at
 * day granularity and rolled up into weeks or months here. A profile only ever sees its own
 * characters: every query joins through `characters.user_id`.
 */

export const RANGES = { "7d": 7, "30d": 30, "90d": 90, "1y": 365, all: null } as const;
export type Range = keyof typeof RANGES;
export const GROUPINGS = ["day", "week", "month"] as const;
export type Grouping = (typeof GROUPINGS)[number];
export type Stack = "character" | "source";

export type Filters = {
  range: Range;
  grouping: Grouping;
  // Empty means every character.
  characterIds: number[];
  source: Source | "all";
  stack: Stack;
};

const DEFAULT_GROUPING: Record<Range, Grouping> = { "7d": "day", "30d": "day", "90d": "week", "1y": "week", all: "month" };

type Params = Record<string, string | string[] | undefined>;

function one(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** Filters from the page's query string; anything unknown falls back to the default. */
export function parseFilters(params: Params): Filters {
  const rawRange = one(params.range);
  const range: Range = rawRange && Object.hasOwn(RANGES, rawRange) ? (rawRange as Range) : "30d";
  const rawGrouping = one(params.group);
  const grouping = GROUPINGS.find((g) => g === rawGrouping) ?? DEFAULT_GROUPING[range];
  const characterIds = [...new Set([params.c ?? []].flat().map(Number))].filter((id) => Number.isSafeInteger(id) && id > 0);
  const rawSource = one(params.source);
  const source = SOURCES.find((s) => s === rawSource) ?? "all";
  const stack: Stack = one(params.stack) === "source" ? "source" : "character";
  return { range, grouping, characterIds, source, stack };
}

/** YYYY-MM-DD of a date in UTC. */
export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDay(date);
}

/** The first day of the bucket a day falls in: itself, its week's Monday, or the 1st of its month. */
export function bucketOf(day: string, grouping: Grouping): string {
  if (grouping === "day") return day;
  if (grouping === "month") return `${day.slice(0, 7)}-01`;
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(day, -((weekday + 6) % 7));
}

/** Every bucket from the one holding `from` to the one holding `to`, so quiet periods show as gaps. */
export function bucketsBetween(from: string, to: string, grouping: Grouping): string[] {
  const out: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) {
    const bucket = bucketOf(day, grouping);
    if (out.at(-1) !== bucket) out.push(bucket);
  }
  return out;
}

/** One character's income from one journal ref type on one UTC day. */
export type DayRow = { day: string; characterId: number; refType: string; amount: number; tax: number; hours: number };

export type Bucket = {
  key: string;
  total: number;
  byCharacter: Record<number, number>;
  bySource: Record<Source, number>;
};

export type CharacterStats = {
  characterId: number;
  amount: number;
  bySource: Record<Source, number>;
  tax: number;
  activeDays: number;
  // UTC hours with at least one bounty payout. Bounties pay out every 20 minutes while killing
  // NPCs, so this approximates time spent ratting; ESS payouts carry no such signal.
  bountyHours: number;
  bestDay: { day: string; amount: number } | null;
  lastDay: string | null;
};

export type Report = {
  from: string;
  to: string;
  grouping: Grouping;
  buckets: Bucket[];
  totals: Omit<CharacterStats, "characterId" | "lastDay">;
  characters: CharacterStats[];
};

const zeroSources = (): Record<Source, number> => ({ bounties: 0, ess: 0 });

function emptyStats(characterId: number): CharacterStats {
  return { characterId, amount: 0, bySource: zeroSources(), tax: 0, activeDays: 0, bountyHours: 0, bestDay: null, lastDay: null };
}

/** Rolls day rows up into chart buckets and per-character and overall figures. Pure. */
export function buildReport(rows: DayRow[], from: string, to: string, grouping: Grouping): Report {
  const buckets = new Map(
    bucketsBetween(from, to, grouping).map((key) => [key, { key, total: 0, byCharacter: {}, bySource: zeroSources() } as Bucket]),
  );
  const stats = new Map<number, CharacterStats>();
  // Per character per day, and per day overall: for active days and best days.
  const characterDays = new Map<number, Map<string, number>>();
  const days = new Map<string, number>();
  const totals: Report["totals"] = { amount: 0, bySource: zeroSources(), tax: 0, activeDays: 0, bountyHours: 0, bestDay: null };

  for (const row of rows) {
    const source = sourceOf(row.refType);
    if (!source || row.day < from || row.day > to) continue;
    const bucket = buckets.get(bucketOf(row.day, grouping))!;
    bucket.total += row.amount;
    bucket.byCharacter[row.characterId] = (bucket.byCharacter[row.characterId] ?? 0) + row.amount;
    bucket.bySource[source] += row.amount;

    let character = stats.get(row.characterId);
    if (!character) stats.set(row.characterId, (character = emptyStats(row.characterId)));
    for (const s of [character, totals]) {
      s.amount += row.amount;
      s.bySource[source] += row.amount;
      s.tax += row.tax;
      if (source === "bounties") s.bountyHours += row.hours;
    }
    if (!character.lastDay || row.day > character.lastDay) character.lastDay = row.day;
    const perDay = characterDays.get(row.characterId) ?? new Map<string, number>();
    characterDays.set(row.characterId, perDay);
    perDay.set(row.day, (perDay.get(row.day) ?? 0) + row.amount);
    days.set(row.day, (days.get(row.day) ?? 0) + row.amount);
  }

  const best = (perDay: Map<string, number>) =>
    [...perDay].reduce<{ day: string; amount: number } | null>(
      (top, [day, amount]) => (!top || amount > top.amount ? { day, amount } : top),
      null,
    );
  for (const [id, perDay] of characterDays) {
    const character = stats.get(id)!;
    character.activeDays = perDay.size;
    character.bestDay = best(perDay);
  }
  totals.activeDays = days.size;
  totals.bestDay = best(days);

  return {
    from,
    to,
    grouping,
    buckets: [...buckets.values()],
    totals,
    characters: [...stats.values()].sort((a, b) => b.amount - a.amount),
  };
}

function refTypesFor(source: Filters["source"]): string[] {
  return source === "all" ? RATTING_REF_TYPES : RATTING_REF_TYPES.filter((refType) => sourceOf(refType) === source);
}

/** The first day in range: `n` days back including today, or the profile's oldest entry for "all". */
async function rangeStart(userId: string, range: Range, today: string): Promise<string> {
  const days = RANGES[range];
  if (days !== null) return addDays(today, -(days - 1));
  const [oldest] = await db
    .select({ date: sql<Date | null>`min(${rattingEntries.date})`.mapWith(rattingEntries.date) })
    .from(rattingEntries)
    .innerJoin(characters, eq(characters.id, rattingEntries.characterId))
    .where(eq(characters.userId, userId));
  return oldest?.date ? utcDay(oldest.date) : today;
}

function entryFilters(userId: string, filters: Filters, from: string) {
  return and(
    eq(characters.userId, userId),
    gte(rattingEntries.date, new Date(`${from}T00:00:00Z`)),
    inArray(rattingEntries.refType, refTypesFor(filters.source)),
    filters.characterIds.length > 0 ? inArray(rattingEntries.characterId, filters.characterIds) : undefined,
  );
}

export async function rattingReport(userId: string, filters: Filters, now = new Date()): Promise<Report> {
  const to = utcDay(now);
  const from = await rangeStart(userId, filters.range, to);
  const day = sql<string>`to_char(${rattingEntries.date} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      day,
      characterId: rattingEntries.characterId,
      refType: rattingEntries.refType,
      amount: sum(rattingEntries.amount).mapWith(Number),
      tax: sum(rattingEntries.tax).mapWith(Number),
      hours: sql<number>`count(DISTINCT date_trunc('hour', ${rattingEntries.date} AT TIME ZONE 'UTC'))`.mapWith(Number),
    })
    .from(rattingEntries)
    .innerJoin(characters, eq(characters.id, rattingEntries.characterId))
    .where(entryFilters(userId, filters, from))
    .groupBy(day, rattingEntries.characterId, rattingEntries.refType);
  return buildReport(rows, from, to, filters.grouping);
}

export type SystemStats = { solarSystemId: number; amount: number; characters: number };

/** Where the income was made, best first. Only bounties name a system; ESS payouts do not. */
export async function topSystems(userId: string, filters: Filters, from: string, limit = 10): Promise<SystemStats[]> {
  const amount = sum(rattingEntries.amount).mapWith(Number);
  const rows = await db
    .select({
      solarSystemId: rattingEntries.solarSystemId,
      amount,
      characters: sql<number>`count(DISTINCT ${rattingEntries.characterId})`.mapWith(Number),
    })
    .from(rattingEntries)
    .innerJoin(characters, eq(characters.id, rattingEntries.characterId))
    .where(and(entryFilters(userId, filters, from), isNotNull(rattingEntries.solarSystemId)))
    .groupBy(rattingEntries.solarSystemId)
    .orderBy(desc(amount))
    .limit(limit);
  return rows.map((row) => ({ ...row, solarSystemId: row.solarSystemId! }));
}

export type TrackedCharacter = {
  id: number;
  name: string;
  tracking: boolean;
  entries: number;
  historyFrom: Date | null;
  syncedAt: Date | null;
  error: string | null;
};

/** The profile's characters with their tracking state, for the filter and the sync status list. */
export async function trackedCharacters(userId: string): Promise<TrackedCharacter[]> {
  const rows = await db
    .select({
      id: characters.id,
      name: characters.name,
      scopes: characters.scopes,
      entries: sql<number>`(SELECT count(*) FROM ${rattingEntries} WHERE ${rattingEntries.characterId} = ${characters.id})`.mapWith(Number),
      historyFrom: walletSyncs.historyFrom,
      syncedAt: walletSyncs.syncedAt,
      error: walletSyncs.error,
    })
    .from(characters)
    .leftJoin(walletSyncs, eq(walletSyncs.characterId, characters.id))
    .where(eq(characters.userId, userId))
    .orderBy(asc(characters.createdAt), asc(characters.id));
  return rows.map(({ scopes, ...row }) => ({ ...row, tracking: hasFeature(scopes, "wallet") }));
}
