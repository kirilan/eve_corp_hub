import "server-only";
import { env } from "@/lib/env";
import { deadlineSignal } from "@/lib/eve/deadline";
import type { ZkillKillmail } from "./killmail";

/**
 * zKillboard, read politely (https://zkillboard.com/api/docs/): an identifying User-Agent, compressed
 * responses (fetch asks for them itself), one request at a time with a pause between them, and
 * nothing more often than the weekly crawl needs.
 */

const BASE = "https://zkillboard.com";
const REQUEST_TIMEOUT_MS = 20_000;
const PAUSE_MS = 1_000;
// The API answers at most 200 killmails a page; nobody in the top 50 loses 600 ships a week.
const MAX_PAGES = 3;
const PAGE_SIZE = 200;
export const WEEK_SECONDS = 7 * 24 * 60 * 60;

export class ZkillError extends Error {}

let lastRequest = 0;

async function get(path: string, accept: string, signal?: AbortSignal): Promise<Response> {
  const wait = lastRequest + PAUSE_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequest = Date.now();
  const response = await fetch(BASE + path, {
    headers: { Accept: accept, "User-Agent": `Drydock (${env().APP_URL}; ${env().ESI_CONTACT})` },
    signal: deadlineSignal(REQUEST_TIMEOUT_MS, signal),
    cache: "no-store",
  }).catch((error: unknown) => {
    throw new ZkillError(`zKillboard ${path} did not answer: ${error instanceof Error ? error.message : String(error)}`);
  });
  if (!response.ok) throw new ZkillError(`zKillboard ${path} failed (${response.status})`);
  return response;
}

/** The ranks page of the 7-day killers ranking: 500 pilots, best first. */
export async function weeklyRanksPage(signal?: AbortSignal): Promise<string> {
  return (await get("/character/ranks/k/all/weekly/1/overallRank/asc/", "text/html", signal)).text();
}

/** A character's losses over the last 7 days, newest first. */
export async function weeklyLosses(characterId: number, signal?: AbortSignal): Promise<ZkillKillmail[]> {
  const out: ZkillKillmail[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const path = `/api/losses/characterID/${characterId}/pastSeconds/${WEEK_SECONDS}/page/${page}/`;
    const body: unknown = await (await get(path, "application/json", signal)).json().catch(() => null);
    // Older endpoints report errors as a JSON object with a 200 status.
    if (!Array.isArray(body)) throw new ZkillError(`zKillboard ${path} returned no list: ${JSON.stringify(body)?.slice(0, 200)}`);
    out.push(...(body as ZkillKillmail[]));
    if (body.length < PAGE_SIZE) break;
  }
  return out;
}

export type ShipKills = { shipTypeId: number; kills: number; iskDestroyed: number };

// Kills flown in a capsule are smartbombs, bubbles and the like: no hull to credit them to.
const CAPSULES = new Set([670, 33328]);

/**
 * The "Top Ships" list from a character's zKillboard stats: kills (killmails they were on) and the ISK
 * destroyed per hull flown, over the same recent 7 days as the weekly ranking. zKillboard keeps the
 * best few hulls (about ten). An answer without the list gives none rather than failing the crawl.
 */
export function parseTopShips(stats: unknown): ShipKills[] {
  const lists = (stats as { topLists?: unknown } | null)?.topLists;
  if (!Array.isArray(lists)) return [];
  const ships = lists.find((list) => (list as { type?: unknown })?.type === "shipType") as { values?: unknown } | undefined;
  if (!Array.isArray(ships?.values)) return [];
  const out = new Map<number, ShipKills>();
  for (const value of ships.values as { shipTypeID?: unknown; kills?: unknown; isk?: unknown }[]) {
    const shipTypeId = Number(value?.shipTypeID);
    const kills = Number(value?.kills);
    if (!Number.isSafeInteger(shipTypeId) || shipTypeId <= 0 || CAPSULES.has(shipTypeId) || !Number.isSafeInteger(kills) || kills <= 0) continue;
    if (!out.has(shipTypeId)) out.set(shipTypeId, { shipTypeId, kills, iskDestroyed: Number(value.isk) || 0 });
  }
  return [...out.values()];
}

/** What a character killed in each hull over the last 7 days, from their zKillboard stats. */
export async function weeklyShipKills(characterId: number, signal?: AbortSignal): Promise<ShipKills[]> {
  const path = `/api/stats/characterID/${characterId}/`;
  return parseTopShips(await (await get(path, "application/json", signal)).json().catch(() => null));
}
