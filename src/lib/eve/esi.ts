import "server-only";
import { env } from "@/lib/env";
import { deadlineSignal, OPERATION_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "./deadline";

const BASE = "https://esi.evetech.net";
// Pinned response-shape version (GET /meta/compatibility-dates); same pin as eve-skills.
const COMPAT_DATE = "2026-08-18";

export class EsiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type EsiInit = { method?: "GET" | "POST" | "DELETE"; body?: unknown; token?: string; signal?: AbortSignal };

async function request(path: string, init: EsiInit): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": `eve_corp_hub (${env().ESI_CONTACT})`,
    "X-Compatibility-Date": COMPAT_DATE,
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(BASE + path, {
    signal: deadlineSignal(REQUEST_TIMEOUT_MS, init.signal),
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  }).catch(rethrowRequestError);
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new EsiError(`ESI ${init.method ?? "GET"} ${path} failed (${response.status}): ${detail?.error ?? response.statusText}`, response.status);
  }
  return response;
}

export async function esi<T>(path: string, init: EsiInit = {}): Promise<T> {
  const response = await request(path, init);
  if (response.status === 204) return undefined as T;
  return (await response.json().catch(rethrowRequestError)) as T;
}

function rethrowRequestError(error: unknown): never {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    throw new EsiError("EVE did not respond within the request's time budget. Try again shortly.", 504);
  }
  throw error;
}

// Wallet journals of busy traders can run to dozens of pages; a caller that needs more says so.
const MAX_PAGES = 50;
// Pages after the first are fetched this many at a time.
const PAGE_CONCURRENCY = 8;

/**
 * Every page of a paged GET (`?page=`, total in `X-Pages`), concatenated in page order. The first page
 * says how many there are; the rest are fetched in parallel.
 */
export async function esiPages<T>(path: string, init: { token?: string; maxPages?: number; signal?: AbortSignal } = {}): Promise<T[]> {
  const signal = deadlineSignal(OPERATION_TIMEOUT_MS, init.signal);
  const maxPages = init.maxPages ?? MAX_PAGES;
  if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new Error("Invalid ESI page limit");
  const separator = path.includes("?") ? "&" : "?";
  const page = async (n: number) => {
    if (signal.aborted) rethrowRequestError(signal.reason);
    const response = await request(`${path}${separator}page=${n}`, { token: init.token, signal });
    const pages = Number(response.headers.get("X-Pages") ?? 1);
    if (!Number.isSafeInteger(pages) || pages < 1 || pages > maxPages) {
      throw new EsiError(`ESI returned an incomplete result: ${pages} pages exceeds or violates the ${maxPages}-page limit.`, 502);
    }
    return { pages, rows: (await response.json().catch(rethrowRequestError)) as T[] };
  };
  const first = await page(1);
  const last = first.pages;
  const out = [first.rows];
  for (let start = 2; start <= last; start += PAGE_CONCURRENCY) {
    const batch = Array.from({ length: Math.min(PAGE_CONCURRENCY, last - start + 1) }, (_, i) => page(start + i));
    const pages = await Promise.all(batch);
    if (pages.some((p) => p.pages !== last)) throw new EsiError("ESI pagination changed during the read; try again.", 502);
    out.push(...pages.map((p) => p.rows));
  }
  return out.flat();
}

export type Affiliation = { character_id: number; corporation_id: number; alliance_id?: number; faction_id?: number };

/** Current corporation and alliance for up to 1000 characters per call; public, no token. */
export async function affiliations(characterIds: number[]): Promise<Affiliation[]> {
  const out: Affiliation[] = [];
  for (let i = 0; i < characterIds.length; i += 1000) {
    out.push(...(await esi<Affiliation[]>("/characters/affiliation", { method: "POST", body: characterIds.slice(i, i + 1000) })));
  }
  return out;
}

export type EsiName = { id: number; name: string; category: string };

export async function names(ids: number[]): Promise<EsiName[]> {
  const unique = [...new Set(ids)];
  const out: EsiName[] = [];
  for (let i = 0; i < unique.length; i += 1000) {
    out.push(...(await esi<EsiName[]>("/universe/names", { method: "POST", body: unique.slice(i, i + 1000) })));
  }
  return out;
}
