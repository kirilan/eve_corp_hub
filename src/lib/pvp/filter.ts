/**
 * The Top PvP fits view's URL state: which weeks are open, and the search across every week. Pure, so
 * it runs on the server and in tests alike.
 */

export type PvpFilter = { q?: string; minValue?: number; maxValue?: number; minKills?: number };

type Params = Record<string, string | string[] | undefined>;

const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : undefined);

/**
 * ISK as players write it: "450m", "1.2b", "750k", "2,5b", "1 200 000 000". A bare number of 10,000 or
 * less is read as millions ("300" is 300M), since nobody filters ships by a few thousand ISK. Returns
 * undefined for anything else.
 */
export function parseIsk(input: string | undefined): number | undefined {
  const match = /^([\d .,_]*\d[\d .,_]*?)\s*([kmbt]?)(?:\s*isk)?$/.exec(input?.trim().toLowerCase() ?? "");
  if (!match) return undefined;
  const digits = match[1].replace(/[ _]/g, "");
  // "1,200,000" groups thousands; any other comma is a decimal comma ("2,5b").
  const number = Number(/^\d{1,3}(,\d{3})+$/.test(digits) ? digits.replace(/,/g, "") : digits.replace(",", "."));
  if (!Number.isFinite(number)) return undefined;
  const scale = { k: 1e3, m: 1e6, b: 1e9, t: 1e12 }[match[2]] ?? (number <= 10_000 ? 1e6 : 1);
  return number * scale;
}

/** The search from `?q=&min=&max=&kills=`; empty when none of them is set to something usable. */
export function parseFilter(params: Params): PvpFilter {
  const q = one(params.q)?.trim().slice(0, 100) || undefined;
  const minValue = parseIsk(one(params.min));
  const maxValue = parseIsk(one(params.max));
  const kills = one(params.kills)?.trim();
  const minKills = kills && /^\d{1,6}$/.test(kills) && Number(kills) > 0 ? Number(kills) : undefined;
  return {
    ...(q && { q }),
    ...(minValue !== undefined && { minValue }),
    ...(maxValue !== undefined && { maxValue }),
    ...(minKills !== undefined && { minKills }),
  };
}

export function isFiltering(filter: PvpFilter): boolean {
  return filter.q !== undefined || filter.minValue !== undefined || filter.maxValue !== undefined || filter.minKills !== undefined;
}

/**
 * The weeks open in the list, from `?week=`: a comma-separated list of crawl ids, or "none". Without it,
 * only the latest week is open. Unknown ids are dropped.
 */
export function openWeeks(params: Params, weekIds: number[]): number[] {
  const raw = one(params.week);
  if (raw === undefined) return weekIds.slice(0, 1);
  const wanted = new Set(raw.split(",").filter((id) => /^\d{1,15}$/.test(id)).map(Number));
  return weekIds.filter((id) => wanted.has(id));
}

/** The link that opens or closes week `id`, given the open weeks; the default (latest only) is the bare path. */
export function toggleWeekHref(path: string, id: number, open: number[], weekIds: number[]): string {
  const next = open.includes(id) ? open.filter((other) => other !== id) : weekIds.filter((other) => other === id || open.includes(other));
  if (next.length === 1 && next[0] === weekIds[0]) return path;
  return `${path}?week=${next.length === 0 ? "none" : next.join(",")}`;
}
