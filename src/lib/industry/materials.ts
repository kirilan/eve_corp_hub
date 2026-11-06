import "server-only";
import data from "./type-materials.json";

/**
 * What each type reprocesses into, from CCP's static data export (regenerate with `pnpm sde:materials`).
 * Server-only: the table is about 430 KB and the browser only needs the rows for the pasted items.
 */
type Table = {
  sde: { buildNumber: number; releaseDate: string };
  // Ore and ice: the processing skill that raises each one's yield, and those skills' names.
  skillNames: Record<string, string>;
  oreSkills: Record<string, number>;
  // typeId -> [portion size, [material, units per portion, material, units per portion, …]]
  types: Record<string, [number, number[]]>;
};

const table = data as unknown as Table;

export const SDE_BUILD = table.sde;

export type Reprocessing = { portionSize: number; materials: [number, number][]; oreSkill: number | null };

/** How a type reprocesses, or null when it cannot be. `oreSkill` is set for ore and ice, which do not use Scrapmetal Processing. */
export function reprocessing(typeId: number): Reprocessing | null {
  const row = table.types[typeId];
  if (!row) return null;
  const [portionSize, flat] = row;
  const materials: [number, number][] = [];
  for (let i = 0; i < flat.length; i += 2) materials.push([flat[i], flat[i + 1]]);
  return { portionSize, materials, oreSkill: table.oreSkills[typeId] ?? null };
}

/** Every ore and ice processing skill, by type id. */
export const ORE_SKILL_NAMES: Record<number, string> = table.skillNames;
