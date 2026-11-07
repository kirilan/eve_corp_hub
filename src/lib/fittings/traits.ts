import "server-only";
import data from "./ship-traits.json";

/** [amount as shown in game ("7.5%", "+1", or "" when none), text] */
export type ShipBonus = [string, string];
export type ShipTraits = { skills: [string, ShipBonus[]][]; role: ShipBonus[]; misc: ShipBonus[] };

const ships = data.ships as unknown as Record<string, ShipTraits | undefined>;

/** A hull's bonuses as the game's Traits tab lists them (from the SDE, `pnpm sde:traits`), or null for none. */
export function shipTraits(shipTypeId: number): ShipTraits | null {
  return ships[shipTypeId] ?? null;
}
