import { type Hub, HUB_KEYS, hubInfo } from "./hubs";

/**
 * Reprocessing yields, taxes and fees: the formulas, and the settings the calculator works them out
 * from. Pure, so the browser recomputes as the player changes a skill or a rate. Sources (checked
 * 2026-11-06): EVE University's Reprocessing and Tax pages (wiki.eveuniversity.org), CCP's patch notes
 * for the sales tax (7.5% since 2025-03-12) and the Upwell broker fee (0.5% SCC surcharge plus the
 * owner's share, 1% at the least).
 */

export const SKILL = {
  scrapmetal: 12196,
  reprocessing: 3385,
  efficiency: 3389,
  accounting: 16622,
  brokerRelations: 3446,
  connections: 3359,
  diplomacy: 3357,
} as const;

export const IMPLANTS = [
  { label: "No reprocessing implant", bonus: 0 },
  { label: "Zainou 'Beancounter' Reprocessing RX-801", bonus: 0.01 },
  { label: "Zainou 'Beancounter' Reprocessing RX-802", bonus: 0.02 },
  { label: "Zainou 'Beancounter' Reprocessing RX-804", bonus: 0.04 },
] as const;

export const STRUCTURES = {
  citadel: { label: "Citadel or engineering complex", bonus: 0 },
  athanor: { label: "Athanor", bonus: 0.02 },
  tatara: { label: "Tatara", bonus: 0.055 },
} as const;

export type StructureKind = keyof typeof STRUCTURES;

export const RIGS = [
  { label: "No reprocessing rig", points: 0 },
  { label: "T1 reprocessing rig", points: 1 },
  { label: "T2 reprocessing rig", points: 3 },
] as const;

/** A character's skill levels and standings, as read from ESI: only the ones the calculator uses. */
export type CharacterData = { id: number; name: string; skills: Record<number, number>; standings: Record<number, number> };

export type SkillSettings = {
  scrapmetal: number;
  reprocessing: number;
  efficiency: number;
  // Ore and ice processing skills by type id; a skill not listed is at `otherOre`.
  ore: Record<number, number>;
  otherOre: number;
  // Index into IMPLANTS.
  implant: number;
};

/** Per hub, as typed (percentages as text, so a half-typed "1." stays put). */
export type HubSettings = {
  reprocessingTax: string;
  salesTax: string;
  brokerFee: string;
  structure: StructureKind;
  // Index into RIGS.
  rig: number;
};

export const ALL_V: SkillSettings = { scrapmetal: 5, reprocessing: 5, efficiency: 5, ore: {}, otherOre: 5, implant: 0 };

/** Sales tax: 7.5%, less 11% of it per level of Accounting. Paid on every sale, at every hub. */
export function salesTax(accounting: number): number {
  return 0.075 * (1 - 0.11 * accounting);
}

/**
 * Broker fee for a sell order at an NPC station: 3%, less 0.3% per level of Broker Relations, 0.03% per
 * point of standing with the owner's faction and 0.02% per point with the owner corporation. Uses
 * standings as they are, without the social skills.
 */
export function npcBrokerFee(brokerRelations: number, factionStanding: number, corporationStanding: number): number {
  return Math.max(0, 0.03 - 0.003 * brokerRelations - 0.0003 * factionStanding - 0.0002 * corporationStanding);
}

/** Standing as the game applies it: Connections lifts a positive one towards 10, Diplomacy a negative one. */
export function effectiveStanding(base: number, connections: number, diplomacy: number): number {
  return base + (10 - base) * 0.04 * (base >= 0 ? connections : diplomacy);
}

/** NPC station reprocessing tax: the station's take at standing 0, falling to nothing at 6.67 with its owner. */
export function npcReprocessingTax(stationTake: number, standing: number): number {
  return stationTake * Math.max(0, 1 - 0.15 * standing);
}

/** Modules, ships, ammunition and the like: the base yield plus 2% of it per level of Scrapmetal Processing. Rigs and implants do not apply. */
export function scrapYield(hub: Hub, scrapmetal: number): number {
  const info = hubInfo(hub);
  return (info.structure ? 0.5 : info.baseYield) * (1 + 0.02 * scrapmetal);
}

/** The facility's ore yield before skills: a station's base, or a structure's with its rig, security and hull bonuses. */
export function oreBaseYield(hub: Hub, settings: HubSettings): number {
  const info = hubInfo(hub);
  if (!info.structure) return info.baseYield;
  const rig = RIGS[settings.rig]?.points ?? 0;
  return ((50 + rig) / 100) * (1 + (rig > 0 ? info.securityBonus : 0)) * (1 + STRUCTURES[settings.structure].bonus);
}

/** Ore and ice: facility base × Reprocessing (3%/level) × Reprocessing Efficiency (2%/level) × the ore's own skill (2%/level) × implant. */
export function oreYield(hub: Hub, settings: HubSettings, skills: SkillSettings, oreSkill: number): number {
  const own = skills.ore[oreSkill] ?? skills.otherOre;
  return (
    oreBaseYield(hub, settings) *
    (1 + 0.03 * skills.reprocessing) *
    (1 + 0.02 * skills.efficiency) *
    (1 + 0.02 * own) *
    (1 + (IMPLANTS[skills.implant]?.bonus ?? 0))
  );
}

/** A fraction as a percentage to type into a field: 0.03375 -> "3.375". */
export function percentText(fraction: number): string {
  return String(Number((fraction * 100).toFixed(3)));
}

/** A typed percentage as a fraction, kept between 0 and 100%. */
export function fromPercent(text: string): number {
  const value = Number(text);
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 100) / 100 : 0;
}

/**
 * Rates with no character picked: every skill at V and no standings. A structure's own rates are
 * unknown until the player enters them: reprocessing tax 0, broker fee at the 1% minimum.
 */
export function defaultHubSettings(hub: Hub): HubSettings {
  const info = hubInfo(hub);
  const sales = percentText(salesTax(5));
  if (info.structure) return { reprocessingTax: "0", salesTax: sales, brokerFee: "1", structure: "citadel", rig: 0 };
  return {
    reprocessingTax: percentText(npcReprocessingTax(info.stationTake, 0)),
    salesTax: sales,
    brokerFee: percentText(npcBrokerFee(5, 0, 0)),
    structure: "citadel",
    rig: 0,
  };
}

export const defaultSettings = (): Record<Hub, HubSettings> =>
  Object.fromEntries(HUB_KEYS.map((hub) => [hub, defaultHubSettings(hub)])) as Record<Hub, HubSettings>;

/**
 * A character's skills, and rates estimated from its skills and standings. A structure's
 * reprocessing tax, broker fee and fittings are the owner's and stay as they were.
 */
export function fromCharacter(
  character: CharacterData,
  current: { skills: SkillSettings; hubs: Record<Hub, HubSettings> },
): { skills: SkillSettings; hubs: Record<Hub, HubSettings> } {
  const level = (skill: number) => character.skills[skill] ?? 0;
  const skills: SkillSettings = {
    scrapmetal: level(SKILL.scrapmetal),
    reprocessing: level(SKILL.reprocessing),
    efficiency: level(SKILL.efficiency),
    // Only ore skills are ever looked up here; an untrained one is absent, so level 0.
    ore: Object.fromEntries(Object.entries(character.skills).map(([id, lvl]) => [Number(id), lvl])),
    otherOre: 0,
    // ESI's implant list needs yet another scope; the player picks it.
    implant: current.skills.implant,
  };
  const sales = percentText(salesTax(level(SKILL.accounting)));
  const hubs = Object.fromEntries(
    HUB_KEYS.map((hub) => {
      const info = hubInfo(hub);
      if (info.structure) return [hub, { ...current.hubs[hub], salesTax: sales }];
      const corporation = character.standings[info.owner.id] ?? 0;
      const faction = character.standings[info.faction.id] ?? 0;
      const taxStanding = info.owner.id in character.standings ? effectiveStanding(corporation, level(SKILL.connections), level(SKILL.diplomacy)) : 0;
      return [
        hub,
        {
          ...current.hubs[hub],
          reprocessingTax: percentText(npcReprocessingTax(info.stationTake, taxStanding)),
          salesTax: sales,
          brokerFee: percentText(npcBrokerFee(level(SKILL.brokerRelations), faction, corporation)),
        },
      ];
    }),
  ) as Record<Hub, HubSettings>;
  return { skills, hubs };
}
