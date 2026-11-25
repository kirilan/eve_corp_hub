import type { RawKillmail } from "./r2z2";
import { isHighsec, isHull } from "./static-data";

/**
 * Whether a killmail can say anything about small-gang PvP outside highsec:
 * - the victim is a ship hull (not a capsule, structure, deployable or NPC),
 * - the system is not highsec (no ganks, no empire wars),
 * - the victim has a pilot,
 * - at least one player attacker is outside the victim's corporation and alliance, which drops
 *   NPC-only kills and awoxing.
 */
export function isSmallGangCandidate(killmail: RawKillmail): boolean {
  const { victim } = killmail;
  if (!isHull(victim.ship_type_id) || isHighsec(killmail.solar_system_id) || !victim.character_id) return false;
  return killmail.attackers.some(
    (attacker) =>
      attacker.character_id !== undefined &&
      attacker.corporation_id !== victim.corporation_id &&
      (victim.alliance_id === undefined || attacker.alliance_id !== victim.alliance_id),
  );
}
