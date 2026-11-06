import data from "@/lib/industry/blueprints.json";

/**
 * Industry recipes from the SDE (`pnpm sde:blueprints`): what a manufacturing or reaction run makes
 * and consumes, what an invention attempt consumes and yields, and the decryptors. Pure lookups.
 */

export const MANUFACTURING = 1;
export const COPYING = 5;
export const INVENTION = 8;
export const REACTIONS = [9, 11];

// An invented copy starts at ME 2 and TE 4, before its decryptor's modifiers.
export const INVENTED_ME = 2;
export const INVENTED_TE = 4;
const MAX_ME = 10;

export type Recipe = { product: number; units: number; materials: [number, number][] };
export type InventionRow = { materials: [number, number][]; products: { blueprint: number; runs: number; chance: number }[] };
export type Decryptor = { typeId: number; me: number; te: number; runs: number; name: string };

const pairs = (flat: number[]): [number, number][] => {
  const out: [number, number][] = [];
  for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]);
  return out;
};
const recipeOf = (row: number[] | undefined): Recipe | null =>
  row ? { product: row[0], units: row[1], materials: pairs(row.slice(2)) } : null;

const manufacturing = data.manufacturing as Record<string, number[]>;
const reaction = data.reaction as Record<string, number[]>;
const invention = data.invention as unknown as Record<string, [number[], [number, number, number][]]>;

export const SDE_BUILD = data.sde.buildNumber;

/** The recipe a job ran: manufacturing or a reaction, by blueprint type. */
export function recipeFor(activityId: number, blueprintTypeId: number): Recipe | null {
  if (activityId === MANUFACTURING) return recipeOf(manufacturing[blueprintTypeId]);
  if (REACTIONS.includes(activityId)) return recipeOf(reaction[blueprintTypeId]);
  return null;
}

/** What one invention attempt from this blueprint consumes, and the blueprints it can make. */
export function inventionFor(blueprintTypeId: number): InventionRow | null {
  const row = invention[blueprintTypeId];
  if (!row) return null;
  return { materials: pairs(row[0]), products: row[1].map(([blueprint, runs, chance]) => ({ blueprint, runs, chance })) };
}

export const DECRYPTORS: Decryptor[] = Object.entries(data.decryptors as unknown as Record<string, [number, number, number, number, string]>).map(
  ([id, [me, te, runs, , name]]) => ({ typeId: Number(id), me, te, runs, name }),
);

/** Blueprints that only invention makes: their copies start at ME 2. */
export const INVENTED_BLUEPRINTS: ReadonlySet<number> = new Set(Object.values(invention).flatMap(([, products]) => products.map(([bp]) => bp)));

/**
 * Units a job of `runs` consumes of a material whose recipe asks `base` per run, at the blueprint's
 * ME. EVE's rule: max(runs, ceil(round(runs * base * (1 - ME/100) * bonus, 2))). Structure and rig
 * bonuses are not reported by ESI, so `bonus` is 1 unless the caller knows better.
 */
export function requiredQuantity(base: number, runs: number, me: number, bonus = 1): number {
  const efficiency = 1 - Math.max(0, Math.min(MAX_ME, me)) / 100;
  return Math.max(runs, Math.ceil(Math.round(runs * base * efficiency * bonus * 100) / 100));
}

/** The decryptors whose modifiers give an invented copy this ME and TE; null stands for "no decryptor". */
export function decryptorCandidates(me: number, te: number): (Decryptor | null)[] {
  const out: (Decryptor | null)[] = me === INVENTED_ME && te === INVENTED_TE ? [null] : [];
  return [...out, ...DECRYPTORS.filter((d) => INVENTED_ME + d.me === me && INVENTED_TE + d.te === te)];
}
