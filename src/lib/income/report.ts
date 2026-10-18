import "server-only";
import { and, asc, desc, eq, gt, gte, inArray, isNotNull, sql, sum } from "drizzle-orm";
import { db } from "@/db";
import { characters, walletEntries, walletSyncs } from "@/db/schema";
import { hasFeature } from "@/lib/eve/sso";
import { CORPORATION_TAX, type Expense, EXPENSES, expenseOf, refTypesOf, SOURCES, sourceOf, type Source } from "./sources";

/**
 * The income tracker's numbers. Everything is per UTC day (EVE time), read from the database at
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
  // Empty means every source.
  sources: Source[];
  stack: Stack;
  // Show taxes and fees against income, which is then counted before corporation tax.
  expenses: boolean;
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
  const picked = new Set([params.s ?? []].flat());
  const sources = SOURCES.filter((s) => picked.has(s));
  const stack: Stack = one(params.stack) === "source" ? "source" : "character";
  const expenses = one(params.exp) === "1";
  // Every source picked is the same view as none picked: keep one URL for it.
  return { range, grouping, characterIds, sources: sources.length === SOURCES.length ? [] : sources, stack, expenses };
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

/** One character's lines of one journal ref type on one UTC day, summed: income is positive, charges negative. */
export type DayRow = { day: string; characterId: number; refType: string; amount: number; tax: number; hours: number };

// Income figures (`total`, `amount`, `bySource`) are what reached the wallet, or with expenses
// shown, what was earned before corporation tax. Expense figures are positive amounts.
export type Bucket = {
  key: string;
  total: number;
  byCharacter: Record<number, number>;
  bySource: Record<Source, number>;
  expenses: number;
  expensesByCharacter: Record<number, number>;
  byExpense: Record<Expense, number>;
};

export type CharacterStats = {
  characterId: number;
  amount: number;
  bySource: Record<Source, number>;
  expenses: number;
  byExpense: Record<Expense, number>;
  // Corporation tax withheld, whether or not expenses are shown.
  tax: number;
  // What the payouts that had tax withheld came to before it, for the tax rate.
  taxedGross: number;
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
  totals: Omit<CharacterStats, "characterId" | "lastDay"> & {
    // Expenses by what they were for ("Broker fees", "Corporation tax", ...), when shown.
    byCharge: Record<string, number>;
  };
  characters: CharacterStats[];
};

const zeroSources = () => Object.fromEntries(SOURCES.map((s) => [s, 0])) as Record<Source, number>;
const zeroExpenses = () => Object.fromEntries(EXPENSES.map((e) => [e, 0])) as Record<Expense, number>;

function emptyFigures(): Omit<CharacterStats, "characterId" | "lastDay"> {
  return {
    amount: 0,
    bySource: zeroSources(),
    expenses: 0,
    byExpense: zeroExpenses(),
    tax: 0,
    taxedGross: 0,
    activeDays: 0,
    bountyHours: 0,
    bestDay: null,
  };
}

function emptyStats(characterId: number): CharacterStats {
  return { characterId, ...emptyFigures(), lastDay: null };
}

/**
 * Rolls day rows up into chart buckets and per-character and overall figures. Pure. With
 * `expenses`, income counts before corporation tax and the tax joins the charges as an expense, so
 * income minus expenses is still what the wallet kept; without, charges are left out.
 */
export function buildReport(rows: DayRow[], from: string, to: string, grouping: Grouping, expenses = false): Report {
  const buckets = new Map(
    bucketsBetween(from, to, grouping).map((key) => [
      key,
      { key, total: 0, byCharacter: {}, bySource: zeroSources(), expenses: 0, expensesByCharacter: {}, byExpense: zeroExpenses() } as Bucket,
    ]),
  );
  const stats = new Map<number, CharacterStats>();
  // Per character per day, and per day overall: for active days and best days.
  const characterDays = new Map<number, Map<string, number>>();
  const days = new Map<string, number>();
  const totals: Report["totals"] = { ...emptyFigures(), byCharge: {} };

  for (const row of rows) {
    if (row.day < from || row.day > to) continue;
    const source = sourceOf(row.refType);
    const charge = expenseOf(row.refType);
    if (!source && !(charge && expenses)) continue;
    const bucket = buckets.get(bucketOf(row.day, grouping))!;
    let character = stats.get(row.characterId);
    if (!character) stats.set(row.characterId, (character = emptyStats(row.characterId)));

    const spend = (expense: Expense, label: string, amount: number) => {
      if (amount <= 0) return;
      bucket.expenses += amount;
      bucket.expensesByCharacter[row.characterId] = (bucket.expensesByCharacter[row.characterId] ?? 0) + amount;
      bucket.byExpense[expense] += amount;
      for (const s of [character, totals]) {
        s.expenses += amount;
        s.byExpense[expense] += amount;
      }
      totals.byCharge[label] = (totals.byCharge[label] ?? 0) + amount;
    };

    if (charge) {
      spend(charge.expense, charge.label, -row.amount);
      continue;
    }
    const amount = expenses ? row.amount + row.tax : row.amount;
    if (expenses) spend("taxes", CORPORATION_TAX, row.tax);
    bucket.total += amount;
    bucket.byCharacter[row.characterId] = (bucket.byCharacter[row.characterId] ?? 0) + amount;
    bucket.bySource[source!] += amount;
    for (const s of [character, totals]) {
      s.amount += amount;
      s.bySource[source!] += amount;
      s.tax += row.tax;
      if (row.tax > 0) s.taxedGross += row.amount + row.tax;
      if (source === "bounties") s.bountyHours += row.hours;
    }
    if (!character.lastDay || row.day > character.lastDay) character.lastDay = row.day;
    const perDay = characterDays.get(row.characterId) ?? new Map<string, number>();
    characterDays.set(row.characterId, perDay);
    perDay.set(row.day, (perDay.get(row.day) ?? 0) + amount);
    days.set(row.day, (days.get(row.day) ?? 0) + amount);
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

/** The first day in range: `n` days back including today, or the profile's oldest entry for "all". */
async function rangeStart(userId: string, range: Range, today: string): Promise<string> {
  const days = RANGES[range];
  if (days !== null) return addDays(today, -(days - 1));
  const [oldest] = await db
    .select({ date: sql<Date | null>`min(${walletEntries.date})`.mapWith(walletEntries.date) })
    .from(walletEntries)
    .innerJoin(characters, eq(characters.id, walletEntries.characterId))
    .where(eq(characters.userId, userId));
  return oldest?.date ? utcDay(oldest.date) : today;
}

function entryFilters(userId: string, filters: Filters, from: string) {
  return and(
    eq(characters.userId, userId),
    gte(walletEntries.date, new Date(`${from}T00:00:00Z`)),
    inArray(walletEntries.refType, refTypesOf(filters.sources.length > 0 ? filters.sources : SOURCES)),
    filters.characterIds.length > 0 ? inArray(walletEntries.characterId, filters.characterIds) : undefined,
  );
}

export async function incomeReport(userId: string, filters: Filters, now = new Date()): Promise<Report> {
  const to = utcDay(now);
  const from = await rangeStart(userId, filters.range, to);
  const day = sql<string>`to_char(${walletEntries.date} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`;
  const rows = await db
    .select({
      day,
      characterId: walletEntries.characterId,
      refType: walletEntries.refType,
      amount: sum(walletEntries.amount).mapWith(Number),
      tax: sum(walletEntries.tax).mapWith(Number),
      hours: sql<number>`count(DISTINCT date_trunc('hour', ${walletEntries.date} AT TIME ZONE 'UTC'))`.mapWith(Number),
    })
    .from(walletEntries)
    .innerJoin(characters, eq(characters.id, walletEntries.characterId))
    .where(entryFilters(userId, filters, from))
    .groupBy(day, walletEntries.characterId, walletEntries.refType);
  return buildReport(rows, from, to, filters.grouping, filters.expenses);
}

export type SystemStats = { solarSystemId: number; amount: number; characters: number };

/**
 * Where bounties were earned, best first: the one source whose journal lines name a system. Empty
 * when the filters leave bounties out.
 */
export async function topSystems(userId: string, filters: Filters, from: string, limit = 10): Promise<SystemStats[]> {
  if (filters.sources.length > 0 && !filters.sources.includes("bounties")) return [];
  const amount = sum(walletEntries.amount).mapWith(Number);
  const rows = await db
    .select({
      solarSystemId: walletEntries.solarSystemId,
      amount,
      characters: sql<number>`count(DISTINCT ${walletEntries.characterId})`.mapWith(Number),
    })
    .from(walletEntries)
    .innerJoin(characters, eq(characters.id, walletEntries.characterId))
    .where(
      and(
        entryFilters(userId, { ...filters, sources: ["bounties"] }, from),
        gt(walletEntries.amount, 0),
        isNotNull(walletEntries.solarSystemId),
      ),
    )
    .groupBy(walletEntries.solarSystemId)
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
      entries: sql<number>`(SELECT count(*) FROM ${walletEntries} WHERE ${walletEntries.characterId} = ${characters.id})`.mapWith(Number),
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
