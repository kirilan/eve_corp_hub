import "server-only";
import { db } from "@/db";
import { pvpCompDays } from "@/db/schema";
import { COMPS_VERSION, planDays, utcDay } from "./days";
import { isSmallGangCandidate } from "./filter";
import { r2z2Day, r2z2Totals, type RawKillmail } from "./r2z2";

/**
 * The fleet comps pipeline's daily job (schedule in vercel.json): reads the days `planDays` picks from
 * zKillboard's dumps, one at a time, until its time budget runs out, and records each in
 * `pvp_comp_days`. A backfill therefore spreads over as many runs as it needs, and the health panel
 * shows how many days are left. A day is recorded only once it is fully processed, so a run cut short
 * loses nothing but the day in hand.
 */

// Stop starting new days this long before the budget ends: a busy day takes a few seconds to read
// and process, a slow download up to a minute.
const DAY_ALLOWANCE_MS = 60_000;

/** What the pipeline keeps from one day. Phase 1 counts the killmails it would keep. */
function processDay(killmails: RawKillmail[]) {
  let kept = 0;
  for (const killmail of killmails) if (isSmallGangCandidate(killmail)) kept += 1;
  return { kept };
}

export async function syncCompDays(budgetMs: number, now = new Date()) {
  const deadline = Date.now() + budgetMs;
  const signal = AbortSignal.timeout(budgetMs);
  const totals = await r2z2Totals(signal);
  const stored = await db.select({ day: pvpCompDays.day, reported: pvpCompDays.reported, version: pvpCompDays.version }).from(pvpCompDays);
  const plan = planDays(utcDay(now), new Map(stored.map((row) => [row.day, row])), totals);

  const done = { new: 0, version: 0, late: 0 };
  const notPublished: string[] = [];
  let killmails = 0;
  let kept = 0;
  for (const { day, reason } of plan) {
    if (Date.now() > deadline - DAY_ALLOWANCE_MS) break;
    const started = Date.now();
    let read: RawKillmail[] | null;
    try {
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
    const result = processDay(read);
    const row = { killmails: read.length, reported: totals.get(day) ?? null, kept: result.kept, version: COMPS_VERSION, processedAt: new Date(), durationMs: Date.now() - started };
    await db.insert(pvpCompDays).values({ day, ...row }).onConflictDoUpdate({ target: pvpCompDays.day, set: row });
    done[reason] += 1;
    killmails += read.length;
    kept += result.kept;
  }

  const read = done.new + done.version + done.late;
  return {
    days: read,
    ...(done.late > 0 && { lateRedone: done.late }),
    // Days still to read: the backlog, and late killmails not yet picked up.
    pending: plan.length - read - notPublished.length,
    ...(notPublished.length > 0 && { notPublished: notPublished.join(" ") }),
    killmails,
    kept,
  };
}
