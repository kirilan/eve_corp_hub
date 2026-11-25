import { pvpType } from "./static-data";

/**
 * The roles a hull plays in a gang, from its ship group. DPS is everything not named here, and is not
 * split into kiting and brawling.
 */

export const ROLES = ["dps", "tackle", "logi", "ewar", "links"] as const;
export type Role = (typeof ROLES)[number];

const ROLE_OF_GROUP = new Map<number, Role>([
  // Logistics, Logistics Frigate, Force Auxiliary
  [832, "logi"],
  [1527, "logi"],
  [1538, "logi"],
  // Interceptor, Interdictor, Heavy Interdiction Cruiser
  [831, "tackle"],
  [541, "tackle"],
  [894, "tackle"],
  // Force Recon Ship, Combat Recon Ship, Electronic Attack Ship
  [833, "ewar"],
  [906, "ewar"],
  [893, "ewar"],
  // Command Ship, Command Destroyer
  [540, "links"],
  [1534, "links"],
]);

export function roleOf(hullTypeId: number): Role {
  const groupId = pvpType(hullTypeId)?.groupId;
  return (groupId !== undefined && ROLE_OF_GROUP.get(groupId)) || "dps";
}

/** Pilots per role, in `ROLES` order: a gang's mix. */
export type Mix = [dps: number, tackle: number, logi: number, ewar: number, links: number];

/**
 * A side's mix: the role of each pilot's hull. A pilot whose hull the killmails do not show (only ever
 * seen in a capsule, say) counts as DPS.
 */
export function mixOf(pilots: number, hulls: number[]): Mix {
  const mix: Mix = [0, 0, 0, 0, 0];
  for (const hull of hulls) mix[ROLES.indexOf(roleOf(hull))] += 1;
  mix[0] += Math.max(0, pilots - hulls.length);
  return mix;
}

/** "3 DPS + 2 tackle". */
export function mixLabel(mix: Mix): string {
  return ROLES.flatMap((role, i) => (mix[i] ? [`${mix[i]} ${role === "dps" || role === "ewar" ? role.toUpperCase() : role}`] : [])).join(" + ");
}
