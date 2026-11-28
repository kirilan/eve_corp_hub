import "server-only";
import { characterAccessToken } from "@/lib/auth/tokens";
import { esi } from "@/lib/eve/esi";
import { HUB_KEYS, hubInfo } from "./hubs";
import { ORE_SKILL_NAMES } from "./materials";
import { type CharacterData, SKILL } from "./rates";

type EsiSkills = { skills: { skill_id: number; active_skill_level: number }[] };
type EsiStanding = { from_id: number; from_type: string; standing: number };

// The skills and standings the calculator uses; everything else ESI returns is dropped here.
const SKILLS = new Set<number>([...Object.values(SKILL), ...Object.keys(ORE_SKILL_NAMES).map(Number)]);
const STANDINGS = new Set<number>(
  HUB_KEYS.flatMap((hub) => {
    const info = hubInfo(hub);
    return info.structure ? [] : [info.owner.id, info.faction.id];
  }),
);

/**
 * One of the profile's own characters, as the calculator needs it: its levels in the reprocessing and
 * trading skills, and its standings with the NPC hubs' owners (and any other `owners`, NPC corporations
 * owning stations it trades at). Read live, never stored. Active levels,
 * so an Alpha clone counts at the levels it can use.
 */
export async function characterRates(
  userId: string,
  characterId: number,
  name: string,
  options: { owners?: number[]; signal?: AbortSignal } = {},
): Promise<CharacterData> {
  const { signal } = options;
  const owners = new Set([...STANDINGS, ...(options.owners ?? [])]);
  const token = await characterAccessToken(userId, characterId, "skills", signal);
  const [skills, standings] = await Promise.all([
    esi<EsiSkills>(`/characters/${characterId}/skills`, { token, signal }),
    esi<EsiStanding[]>(`/characters/${characterId}/standings`, { token, signal }),
  ]);
  return {
    id: characterId,
    name,
    skills: Object.fromEntries(skills.skills.filter((s) => SKILLS.has(s.skill_id) && s.active_skill_level > 0).map((s) => [s.skill_id, s.active_skill_level])),
    standings: Object.fromEntries(standings.filter((s) => s.from_type !== "agent" && owners.has(s.from_id)).map((s) => [s.from_id, s.standing])),
  };
}
