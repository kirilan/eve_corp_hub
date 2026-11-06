/**
 * Where items can be reprocessed and sold. Jita 4-4 is an NPC station: its market is in the public
 * regional feed, and its reprocessing rates come from ESI (`/universe/stations/60003760`:
 * `reprocessing_efficiency` 0.5, `reprocessing_stations_take` 0.05, checked 2026-11-06). 4-HWWF is a
 * player structure: its market is read with a token from a character that can dock there (`markets`
 * consent), and its owner sets the reprocessing tax and broker fee, which ESI does not publish.
 */
type Station = {
  label: string;
  station: string;
  locationId: number;
  regionId: number;
  // Region the daily market history is read for: ESI keeps it per region, not per station.
  regionName: string;
  structure: false;
  // Base reprocessing yield and the station's tax before standings.
  baseYield: number;
  stationTake: number;
  // The station's owner: standings with it lower the reprocessing tax and broker fee.
  owner: { id: number; name: string };
  faction: { id: number; name: string };
};

type Structure = {
  label: string;
  station: string;
  locationId: number;
  regionId: number;
  regionName: string;
  structure: true;
  // The owner's broker fee as the order window shows it, the default until the player enters another.
  brokerFee: number;
  // Ore yield bonus of the system's security, applied only when a reprocessing rig is fitted.
  securityBonus: number;
};

export const HUBS = {
  jita: {
    label: "Jita",
    station: "Jita IV - Moon 4 - Caldari Navy Assembly Plant",
    locationId: 60003760,
    regionId: 10000002,
    regionName: "The Forge",
    structure: false,
    baseYield: 0.5,
    stationTake: 0.05,
    owner: { id: 1000035, name: "Caldari Navy" },
    faction: { id: 500001, name: "Caldari State" },
  },
  "4-hwwf": {
    label: "4-HWWF",
    station: "4-HWWF - WinterCo. Central Station",
    locationId: 1053970513596,
    regionId: 10000003,
    regionName: "Vale of the Silent",
    structure: true,
    // What the order window shows for a sell order there (checked by the user in game, 2026-11-06).
    brokerFee: 0,
    // Null-sec.
    securityBonus: 0.12,
  },
} as const satisfies Record<string, Station | Structure>;

export type Hub = keyof typeof HUBS;

export const HUB_KEYS = Object.keys(HUBS) as Hub[];

export function isHub(value: unknown): value is Hub {
  return typeof value === "string" && Object.hasOwn(HUBS, value);
}

export function hubInfo(hub: Hub): Station | Structure {
  return HUBS[hub];
}
