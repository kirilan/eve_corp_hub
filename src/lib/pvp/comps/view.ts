import "server-only";
import { and, desc, eq, max } from "drizzle-orm";
import { cacheLife, cacheTag } from "next/cache";
import { db } from "@/db";
import { pvpCompDays, pvpCompFits, pvpCompMonths } from "@/db/schema";
import type { Viewer } from "@/lib/auth/accounts";
import { typeNames } from "@/lib/eve/types";
import { FittingError, saveCopy, writeToGame, type Contents } from "@/lib/fittings/store";
import { zkillKillUrl } from "../fits";
import { addDays } from "./days";
import { DEFAULT_CAP, type PriceCap } from "./fights";
import { compsBetween } from "./months";
import { ROLES, roleOf, type Role } from "./roles";
import type { CompResults, ExampleFit } from "./score";

/**
 * What the fleet comps page reads: the comps of the last 30 days or of a saved month at a price cap, and
 * the example fits they point to. Public game data, for everyone. Cached until the daily job invalidates
 * `PVP_COMPS_TAG`.
 */

export const PVP_COMPS_TAG = "pvp-comps";
/** The live view covers this many days, up to yesterday. */
export const LIVE_DAYS = 30;

/** Saved months (at any cap), newest first, as "YYYY-MM". */
export async function compMonths(): Promise<string[]> {
  "use cache";
  cacheTag(PVP_COMPS_TAG);
  cacheLife("days");
  const rows = await db.selectDistinct({ month: pvpCompMonths.month }).from(pvpCompMonths).orderBy(desc(pvpCompMonths.month));
  return rows.map((row) => row.month.slice(0, 7));
}

export type CompPeriod = { from: string; to: string; results: CompResults };

/**
 * The comps at a price cap of the 30 days up to the last day read (at most yesterday, `today` being the
 * UTC day), or null before any day is read.
 */
export async function liveComps(today: string, cap: PriceCap = DEFAULT_CAP): Promise<CompPeriod | null> {
  "use cache";
  cacheTag(PVP_COMPS_TAG);
  cacheLife("hours");
  const [{ last }] = await db.select({ last: max(pvpCompDays.day) }).from(pvpCompDays);
  if (!last) return null;
  const to = last < today ? last : addDays(today, -1);
  const from = addDays(to, 1 - LIVE_DAYS);
  return { from, to, results: await compsBetween(from, to, cap) };
}

/** A saved month ("YYYY-MM") at a price cap, or null if it is not saved at that cap. */
export async function monthComps(month: string, cap: PriceCap = DEFAULT_CAP): Promise<CompPeriod | null> {
  "use cache";
  cacheTag(PVP_COMPS_TAG);
  cacheLife("days");
  if (!/^\d{4}-\d{2}$/.test(month)) return null;
  const [row] = await db
    .select()
    .from(pvpCompMonths)
    .where(and(eq(pvpCompMonths.month, `${month}-01`), eq(pvpCompMonths.cap, cap)));
  if (!row) return null;
  return { from: row.month, to: addDays(nextMonth(row.month), -1), results: row.results };
}

function nextMonth(first: string): string {
  const date = new Date(`${first}T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + 1);
  return date.toISOString().slice(0, 10);
}

/** Names of every hull a period mentions. */
export async function hullNames(results: CompResults): Promise<Record<number, string>> {
  const ids = ROLES.flatMap((role) => results.hulls[role].map((hull) => hull.typeId));
  return Object.fromEntries(await typeNames(ids));
}

export type CompFit = Omit<ExampleFit, "losses"> & { losses: number | null; shipTypeId: number; shipName: string | null; role: Role; day: string | null; month: string | null };

/**
 * An example fit by its killmail: from the stored fits while they are kept, else from the saved month
 * that shows it. Null when neither has it.
 */
export async function compFit(killmailId: number): Promise<CompFit | null> {
  "use cache";
  cacheTag(PVP_COMPS_TAG);
  cacheLife("days");
  if (!Number.isSafeInteger(killmailId) || killmailId <= 0) return null;
  const found = await findFit(killmailId);
  if (!found) return null;
  const names = await typeNames([found.shipTypeId]);
  return { ...found, shipName: names.get(found.shipTypeId) ?? null };
}

async function findFit(killmailId: number): Promise<Omit<CompFit, "shipName"> | null> {
  const months = await db.select().from(pvpCompMonths).orderBy(desc(pvpCompMonths.month));
  for (const { month, results } of months) {
    for (const role of ROLES) {
      const hull = results.hulls[role].find((stat) => stat.fit?.killmailId === killmailId);
      if (hull?.fit) return { ...hull.fit, shipTypeId: hull.typeId, role, day: null, month: month.slice(0, 7) };
    }
  }
  const [row] = await db.select().from(pvpCompFits).where(eq(pvpCompFits.killmailId, killmailId));
  if (!row) return null;
  return {
    killmailId: row.killmailId,
    characterId: row.characterId,
    items: row.items,
    value: row.value,
    // How often winners lost this loadout is counted per period, not per fit.
    losses: null,
    shipTypeId: row.shipTypeId,
    role: roleOf(row.shipTypeId),
    day: row.day,
    month: null,
  };
}

/** What a comp fit is called and says when saved or sent: within EVE's 50 and 500 characters. */
export function compFitContents(fit: CompFit): Contents {
  const ship = fit.shipName ?? `Type ${fit.shipTypeId}`;
  return {
    name: `${ship} (small-gang comp)`.slice(0, 50),
    description: `The loadout winning small gangs lost most in this hull, from Drydock's fleet comps. ${zkillKillUrl(fit.killmailId)}`,
    shipTypeId: fit.shipTypeId,
    items: fit.items,
  };
}

async function contentsOf(killmailId: number): Promise<Contents> {
  const fit = await compFit(killmailId);
  if (!fit) throw new FittingError("Fit not found.");
  return compFitContents(fit);
}

/** Saves a comp's example fit as a private fit of the viewer's own; returns its id. */
export async function copyCompFit(viewer: Viewer, killmailId: number): Promise<string> {
  return saveCopy(viewer, await contentsOf(killmailId));
}

/** Writes a comp's example fit to one of the viewer's characters' saved fittings in game. */
export async function sendCompFit(viewer: Viewer, killmailId: number, characterId: number): Promise<void> {
  await writeToGame(viewer, characterId, await contentsOf(killmailId));
}
