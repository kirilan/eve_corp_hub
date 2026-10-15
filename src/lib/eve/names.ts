import "server-only";
import { cacheLife } from "next/cache";
import { names } from "./esi";

/** Corporation/alliance/character names by id; an ESI failure yields no names rather than an error page. */
export async function entityNames(ids: number[]): Promise<Record<number, string>> {
  const wanted = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b);
  if (wanted.length === 0) return {};
  try {
    return await cachedNames(wanted);
  } catch (error) {
    console.warn("name lookup failed", error);
    return {};
  }
}

// Names almost never change, so a day is plenty. Failures throw through, so they are never cached.
async function cachedNames(ids: number[]): Promise<Record<number, string>> {
  "use cache";
  cacheLife("days");
  return Object.fromEntries((await names(ids)).map((entry) => [entry.id, entry.name]));
}

export function portraitUrl(characterId: number, size: 32 | 64 | 128 | 256 = 64): string {
  return `https://images.evetech.net/characters/${characterId}/portrait?size=${size}`;
}

export function corporationLogoUrl(corporationId: number, size: 32 | 64 | 128 = 32): string {
  return `https://images.evetech.net/corporations/${corporationId}/logo?size=${size}`;
}
