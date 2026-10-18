import "server-only";
import { env } from "@/lib/env";

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

type EsiInit = { method?: "GET" | "POST" | "DELETE"; body?: unknown; token?: string };

async function request(path: string, init: EsiInit): Promise<Response> {
  const headers: Record<string, string> = {
    Accept: "application/json",
    "User-Agent": `eve_corp_hub (${env().ESI_CONTACT})`,
    "X-Compatibility-Date": COMPAT_DATE,
  };
  if (init.token) headers.Authorization = `Bearer ${init.token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(BASE + path, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new EsiError(`ESI ${init.method ?? "GET"} ${path} failed (${response.status}): ${detail?.error ?? response.statusText}`, response.status);
  }
  return response;
}

export async function esi<T>(path: string, init: EsiInit = {}): Promise<T> {
  const response = await request(path, init);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

// Wallet journals of busy traders can run to dozens of pages; nothing we read needs more.
const MAX_PAGES = 50;

/** Every page of a paged GET (`?page=`, total in `X-Pages`), concatenated in page order. */
export async function esiPages<T>(path: string, init: { token?: string } = {}): Promise<T[]> {
  const separator = path.includes("?") ? "&" : "?";
  const out: T[] = [];
  let pages = 1;
  for (let page = 1; page <= Math.min(pages, MAX_PAGES); page++) {
    const response = await request(`${path}${separator}page=${page}`, init);
    pages = Number(response.headers.get("X-Pages") ?? 1) || 1;
    out.push(...((await response.json()) as T[]));
  }
  return out;
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
