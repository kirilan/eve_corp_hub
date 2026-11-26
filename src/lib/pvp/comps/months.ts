import "server-only";
import { and, between, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { pvpCompDays, pvpCompFits, pvpCompHullLosses, pvpCompMonths, pvpCompSides } from "@/db/schema";
import { addDays, COMPS_VERSION, FIRST_DAY, LATE_WINDOW_DAYS } from "./days";
import { DEFAULT_CAP, lossesAt, PRICE_CAPS, type HullLossCounts, type PriceCap } from "./fights";
import { scoreComps, type CompResults, type ScoredFit, type ScoredSide } from "./score";

/**
 * Saved months and the rows behind them. A calendar month is saved for good once every one of its days
 * has been read, and the first day of the next month too (it finishes fights going past midnight).
 * Rows are then deleted once 40 days old, never before their month is saved.
 */

type Rows = { sides: ScoredSide[]; hullLosses: Map<number, HullLossCounts>; fits: ScoredFit[] };

/** The stored rows of the fights whose first kill fell between two UTC days, both included. */
async function rowsBetween(from: string, to: string): Promise<Rows> {
  const [sides, losses, fits] = await Promise.all([
    db
      .select({
        fightId: pvpCompSides.fightId,
        side: pvpCompSides.side,
        pilots: pvpCompSides.pilots,
        enemies: pvpCompSides.enemies,
        iskKilled: pvpCompSides.iskKilled,
        iskLost: pvpCompSides.iskLost,
        hulls: pvpCompSides.hulls,
      })
      .from(pvpCompSides)
      .where(between(pvpCompSides.day, from, to)),
    db.select().from(pvpCompHullLosses).where(between(pvpCompHullLosses.day, from, to)),
    db
      .select({
        killmailId: pvpCompFits.killmailId,
        fightId: pvpCompFits.fightId,
        side: pvpCompFits.side,
        characterId: pvpCompFits.characterId,
        shipTypeId: pvpCompFits.shipTypeId,
        items: pvpCompFits.items,
        loadout: pvpCompFits.loadout,
        value: pvpCompFits.value,
      })
      .from(pvpCompFits)
      .where(between(pvpCompFits.day, from, to)),
  ]);
  const hullLosses = new Map<number, HullLossCounts>();
  for (const row of losses) {
    const total = hullLosses.get(row.shipTypeId) ?? { losses: 0, affordable: 0, under500m: 0, under200m: 0 };
    total.losses += row.losses;
    total.affordable += row.affordable;
    total.under500m += row.under500m;
    total.under200m += row.under200m;
    hullLosses.set(row.shipTypeId, total);
  }
  return { sides, hullLosses, fits };
}

function scoreAt({ sides, hullLosses, fits }: Rows, cap: PriceCap): CompResults {
  const atCap = new Map([...hullLosses].map(([hull, counts]) => [hull, lossesAt(counts, cap)]));
  return scoreComps(sides, atCap, fits, cap);
}

/** The comps at a price cap of the fights whose first kill fell between two UTC days, both included. */
export async function compsBetween(from: string, to: string, cap: PriceCap = DEFAULT_CAP): Promise<CompResults> {
  return scoreAt(await rowsBetween(from, to), cap);
}

const monthOf = (day: string) => `${day.slice(0, 7)}-01`;

function nextMonth(month: string): string {
  const date = new Date(`${month}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

/** Months from the first one read up to the one before `today`'s, oldest first. */
function pastMonths(today: string): string[] {
  const out: string[] = [];
  for (let month = monthOf(FIRST_DAY); month < monthOf(today); month = nextMonth(month)) out.push(month);
  return out;
}

/** For each month saved at any cap, the caps it is saved at. */
async function savedCaps(): Promise<Map<string, Set<number>>> {
  const out = new Map<string, Set<number>>();
  for (const row of await db.select({ month: pvpCompMonths.month, cap: pvpCompMonths.cap }).from(pvpCompMonths)) {
    out.set(row.month, (out.get(row.month) ?? new Set()).add(row.cap));
  }
  return out;
}

/** Whether a month is saved at every price cap. */
const savedAtEveryCap = (saved: Map<string, Set<number>>, month: string) => PRICE_CAPS.every((cap) => saved.get(month)?.has(cap));

/**
 * Saves every complete month at each price cap it is not saved at yet; returns the months saved. A cap
 * added later is filled in for past months once their days are read again (a `COMPS_VERSION` bump),
 * and the months saved before keep their results at the other caps.
 */
export async function saveCompleteMonths(today: string): Promise<string[]> {
  const saved = await savedCaps();
  const pending = pastMonths(today).filter((month) => !savedAtEveryCap(saved, month));
  if (pending.length === 0) return [];
  const read = new Set(
    (await db.select({ day: pvpCompDays.day }).from(pvpCompDays).where(eq(pvpCompDays.version, COMPS_VERSION))).map((row) => row.day),
  );
  const out: string[] = [];
  for (const month of pending) {
    const next = nextMonth(month);
    const last = addDays(next, -1);
    let complete = read.has(next);
    for (let day = month < FIRST_DAY ? FIRST_DAY : month; complete && day <= last; day = addDays(day, 1)) complete = read.has(day);
    if (!complete) continue;
    const rows = await rowsBetween(month, last);
    for (const cap of PRICE_CAPS) {
      if (saved.get(month)?.has(cap)) continue;
      await db.insert(pvpCompMonths).values({ month, cap, results: scoreAt(rows, cap) });
    }
    out.push(month);
  }
  return out;
}

/**
 * Deletes side, fit and loss rows older than 40 days whose month is saved, and the overnight carry of
 * days too old to be read again.
 */
export async function pruneCompRows(today: string) {
  const saved = await savedCaps();
  const unsaved = pastMonths(today).find((month) => !savedAtEveryCap(saved, month)) ?? monthOf(today);
  const cutoff = addDays(today, -LATE_WINDOW_DAYS);
  const before = unsaved < cutoff ? unsaved : cutoff;
  await db.delete(pvpCompSides).where(lt(pvpCompSides.day, before));
  await db.delete(pvpCompFits).where(lt(pvpCompFits.day, before));
  await db.delete(pvpCompHullLosses).where(lt(pvpCompHullLosses.day, before));
  // A day read again needs the day before's carry.
  await db
    .update(pvpCompDays)
    .set({ carry: null })
    .where(and(lt(pvpCompDays.day, addDays(cutoff, -1)), isNotNull(pvpCompDays.carry)));
}
