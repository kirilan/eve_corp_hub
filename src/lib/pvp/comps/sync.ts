import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { pvpCompDays, pvpCompFits, pvpCompHullLosses, pvpCompSides } from "@/db/schema";
import { addDays, COMPS_VERSION, planDays, utcDay } from "./days";
import { processDay, type CompKill, type DayResult } from "./fights";
import { pruneCompRows, saveCompleteMonths } from "./months";
import { compPrices } from "./prices";
import { r2z2Day, r2z2Totals, type RawKillmail } from "./r2z2";

/**
 * The fleet comps pipeline's daily job (schedule in vercel.json): reads the days `planDays` picks from
 * zKillboard's dumps, one at a time, until its time budget runs out, and stores each day's fight sides
 * (`fights.ts`). A backfill therefore spreads over as many runs as it needs, and the health panel shows
 * how many days are left. A day is stored in one transaction, so a run cut short loses nothing but the
 * day in hand. Then it saves every month that is complete and deletes rows no longer needed.
 */

// Stop starting new days this long before the budget ends: a busy day takes a few seconds to read
// and process, a slow download up to a minute.
const DAY_ALLOWANCE_MS = 60_000;
// Rows per insert, well under Postgres's 65,535 parameters.
const CHUNK = 500;

async function insertChunks<T>(rows: T[], insert: (chunk: T[]) => Promise<unknown>) {
  for (let i = 0; i < rows.length; i += CHUNK) await insert(rows.slice(i, i + CHUNK));
}

async function storedCarry(day: string): Promise<CompKill[] | null> {
  const [row] = await db.select({ carry: pvpCompDays.carry }).from(pvpCompDays).where(eq(pvpCompDays.day, day));
  return row?.carry ?? null;
}

/** Replaces what an earlier run stored for `day`, and records the day as read. */
async function storeDay(day: string, result: DayResult, row: { killmails: number; reported: number | null; durationMs: number }) {
  await db.transaction(async (tx) => {
    await tx.delete(pvpCompSides).where(eq(pvpCompSides.processedDay, day));
    await tx.delete(pvpCompFits).where(eq(pvpCompFits.processedDay, day));
    await tx.delete(pvpCompHullLosses).where(eq(pvpCompHullLosses.day, day));
    // A fight is normally stored once; upserts keep a day read again after the next one from failing.
    await insertChunks(result.sides, (chunk) =>
      tx
        .insert(pvpCompSides)
        .values(chunk.map((side) => ({ ...side, processedDay: day })))
        .onConflictDoNothing(),
    );
    await insertChunks(result.fits, (chunk) =>
      tx
        .insert(pvpCompFits)
        .values(chunk.map((fit) => ({ ...fit, processedDay: day })))
        .onConflictDoNothing(),
    );
    await insertChunks([...result.hullLosses], (chunk) =>
      tx.insert(pvpCompHullLosses).values(chunk.map(([shipTypeId, losses]) => ({ day, shipTypeId, ...losses }))),
    );
    const values = { ...row, kept: result.kept, version: COMPS_VERSION, processedAt: new Date(), carry: result.carry };
    await tx.insert(pvpCompDays).values({ day, ...values }).onConflictDoUpdate({ target: pvpCompDays.day, set: values });
  });
}

export async function syncCompDays(budgetMs: number, now = new Date()) {
  const deadline = Date.now() + budgetMs;
  const signal = AbortSignal.timeout(budgetMs);
  const today = utcDay(now);
  const totals = await r2z2Totals(signal);
  const stored = await db.select({ day: pvpCompDays.day, reported: pvpCompDays.reported, version: pvpCompDays.version }).from(pvpCompDays);
  const plan = planDays(today, new Map(stored.map((row) => [row.day, row])), totals);

  const done = { new: 0, version: 0, late: 0 };
  const notPublished: string[] = [];
  let prices: Map<number, number> | null = null;
  let killmails = 0;
  let kept = 0;
  let sides = 0;
  for (const { day, reason } of plan) {
    if (Date.now() > deadline - DAY_ALLOWANCE_MS) break;
    const started = Date.now();
    let read: RawKillmail[] | null;
    try {
      prices ??= await compPrices(signal);
      read = await r2z2Day(day, signal);
    } catch (error) {
      // Out of time part way through a download: the day stays for the next run.
      if (signal.aborted) break;
      throw error;
    }
    if (!read) {
      notPublished.push(day);
      continue;
    }
    const before = reason === "new" ? null : await storedCarry(day);
    const result = processDay(day, read, (await storedCarry(addDays(day, -1))) ?? [], prices);
    await storeDay(day, result, { killmails: read.length, reported: totals.get(day) ?? null, durationMs: Date.now() - started });
    // Fights going past midnight changed: the next day, if read, has to finish them again.
    if (reason !== "new" && JSON.stringify(before ?? []) !== JSON.stringify(result.carry)) {
      await db.update(pvpCompDays).set({ version: 0 }).where(eq(pvpCompDays.day, addDays(day, 1)));
    }
    done[reason] += 1;
    killmails += read.length;
    kept += result.kept;
    sides += result.sides.length;
  }

  const months = await saveCompleteMonths(today);
  await pruneCompRows(today);

  const read = done.new + done.version + done.late;
  return {
    days: read,
    ...(done.late > 0 && { lateRedone: done.late }),
    // Days still to read: the backlog, and late killmails not yet picked up.
    pending: plan.length - read - notPublished.length,
    ...(notPublished.length > 0 && { notPublished: notPublished.join(" ") }),
    killmails,
    kept,
    sides,
    ...(months.length > 0 && { monthsSaved: months.map((month) => month.slice(0, 7)).join(" ") }),
  };
}
