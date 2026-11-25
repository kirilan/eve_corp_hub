import "server-only";
import { ZkillError, zkillFetch } from "../zkill";

/**
 * zKillboard's bulk daily dumps (R2Z2, https://github.com/zKillboard/zKillboard/wiki/API-(R2Z2)): one
 * file per UTC day with every killmail of that day, as ESI serves them and without zKillboard's own
 * `zkb` block. Every file is rebuilt around 06:20 UTC, older days included, so a day can gain late
 * killmails; `totals.json` counts each day's. The limit is 15 requests a second per IP with an hour's
 * ban for going over; this reads a handful a day, through the same pacing as every zKillboard call.
 */

const BASE = "https://r2z2.zkillboard.com/history";
// A day's file is 2.5 to 7 MB compressed and 26 to 70 MB of JSON.
const DAY_TIMEOUT_MS = 90_000;

export type RawKillmail = {
  killmail_id: number;
  killmail_time: string;
  solar_system_id: number;
  victim: {
    character_id?: number;
    corporation_id?: number;
    alliance_id?: number;
    ship_type_id: number;
    items?: { item_type_id: number; flag: number; quantity_destroyed?: number; quantity_dropped?: number; singleton?: number }[];
  };
  attackers: {
    character_id?: number;
    corporation_id?: number;
    alliance_id?: number;
    ship_type_id?: number;
    weapon_type_id?: number;
    final_blow?: boolean;
    damage_done?: number;
  }[];
};

/** "2026-11-24" -> "20261124", the name R2Z2 gives a day. */
const fileDay = (day: string) => day.replaceAll("-", "");

/** Killmails per UTC day, by "YYYY-MM-DD", for every day zKillboard has. */
export async function r2z2Totals(signal?: AbortSignal): Promise<Map<string, number>> {
  const response = await zkillFetch(`${BASE}/totals.json`, "application/json", signal);
  if (!response.ok) throw new ZkillError(`R2Z2 totals.json failed (${response.status})`);
  const body: unknown = await response.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ZkillError("R2Z2 totals.json is not an object of day counts");
  const out = new Map<string, number>();
  for (const [key, value] of Object.entries(body)) {
    if (/^\d{8}$/.test(key) && Number.isSafeInteger(value)) out.set(`${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6)}`, value as number);
  }
  return out;
}

/** Every killmail of one UTC day ("YYYY-MM-DD"), or null when R2Z2 has no file for it (yet). */
export async function r2z2Day(day: string, signal?: AbortSignal): Promise<RawKillmail[] | null> {
  const response = await zkillFetch(`${BASE}/raw/${fileDay(day)}.json`, "application/json", signal, DAY_TIMEOUT_MS);
  if (response.status === 404) {
    await response.body?.cancel();
    return null;
  }
  if (!response.ok) throw new ZkillError(`R2Z2 day ${day} failed (${response.status})`);
  const body: unknown = await response.json().catch((error: unknown) => {
    throw new ZkillError(`R2Z2 day ${day} is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  });
  // An object keyed by killmail id.
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new ZkillError(`R2Z2 day ${day} is not an object of killmails`);
  return Object.values(body) as RawKillmail[];
}
