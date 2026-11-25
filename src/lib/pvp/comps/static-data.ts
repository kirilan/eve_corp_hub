import "server-only";
import data from "./static-data.json";

/**
 * The game data the fleet comps pipeline reads killmails with, from CCP's static data export
 * (regenerate with `pnpm sde:pvp` after a patch). Server-only: the table is about 270 KB.
 */
type Table = {
  sde: { buildNumber: number; releaseDate: string };
  // systemId -> security status as the game shows it (one decimal).
  systems: Record<string, number>;
  // typeId -> [group, category, meta group (0 for none), base price in ISK]; ships, modules, charges,
  // drones, subsystems and fighters only.
  types: Record<string, [number, number, number, number]>;
};

const table = data as unknown as Table;

export const PVP_SDE_BUILD = table.sde;

export const CATEGORY_SHIP = 6;
export const GROUP_CAPSULE = 29;
// Officer, deadspace and abyssal (mutated) modules: kept out of the fits the comps page suggests.
const BANNED_META_GROUPS = new Set([5, 6, 15]);

export type PvpType = { groupId: number; categoryId: number; metaGroupId: number | null; basePrice: number };

export function pvpType(typeId: number): PvpType | null {
  const row = table.types[typeId];
  return row ? { groupId: row[0], categoryId: row[1], metaGroupId: row[2] || null, basePrice: row[3] } : null;
}

/** A ship hull a pilot can fly into a fight: a ship, but not a capsule. */
export function isHull(typeId: number): boolean {
  const type = pvpType(typeId);
  return type !== null && type.categoryId === CATEGORY_SHIP && type.groupId !== GROUP_CAPSULE;
}

/** Officer, deadspace or abyssal. */
export function isBannedModule(typeId: number): boolean {
  const meta = pvpType(typeId)?.metaGroupId;
  return meta != null && BANNED_META_GROUPS.has(meta);
}

/** The security status the game shows for a system, or null for one the export does not know. */
export function systemSecurity(systemId: number): number | null {
  return table.systems[systemId] ?? null;
}

/** Highsec: 0.5 and up as the game shows it. An unknown system counts as highsec, so it is left out. */
export function isHighsec(systemId: number): boolean {
  return (systemSecurity(systemId) ?? 1) >= 0.5;
}
