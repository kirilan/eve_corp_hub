import "server-only";
import { listCharacters } from "@/lib/auth/accounts";
import { characterAccessToken, ConsentMissingError } from "@/lib/auth/tokens";
import { deadlineSignal, OPERATION_TIMEOUT_MS } from "@/lib/eve/deadline";
import { esi, esiCached } from "@/lib/eve/esi";
import { entityNames } from "@/lib/eve/names";
import { hasFeature } from "@/lib/eve/sso";
import { typeNames } from "@/lib/eve/types";
import { characterRates } from "@/lib/industry/character";
import { regionPace } from "@/lib/industry/history";
import { HUBS } from "@/lib/industry/hubs";
import { type HubPrices, locationPrices, type MarketLocation } from "@/lib/industry/market";
import { type Reprocessing, reprocessing } from "@/lib/industry/materials";
import { type CharacterData, effectiveStanding, npcReprocessingTax, SKILL, salesTax } from "@/lib/industry/rates";
import type { Book } from "@/lib/industry/reprocess";
import { facilityYields, type Floor, NO_SKILLS, type ReprocessSkills, reprocessFloor } from "./floor";
import { corpOrders, saveSharedOrders, toShared } from "./shared";
import { type CorpAhead, corpAhead, competitors, type OwnAhead, ownAhead, type Standing, standing, type Status } from "./standing";

/**
 * Open market orders of a profile's characters and where each stands in its station's book, read
 * live when the owner opens the page: nothing here is stored except the public order books, which
 * are cached like the calculator's. Same idea as eve-skills' `orders --check`.
 */

// ESI caches order books for 5 minutes: fresher than that is not possible, older hides an undercut.
const BOOK_MAX_AGE_MS = 5 * 60 * 1000;
// A structure's market is read whole (tens of thousands of orders): not more often than the calculator does.
const STRUCTURE_MAX_AGE_MS = 15 * 60 * 1000;
// On demand (Sync now): ESI's own caches (5 minutes for both) make anything fresher the same data again.
const FRESH_BOOK_MAX_AGE_MS = 60 * 1000;
const FRESH_STRUCTURE_MAX_AGE_MS = 5 * 60 * 1000;
// Player structures have ids above every NPC station's.
const FIRST_STRUCTURE_ID = 1_000_000_000_000;

export type EsiCharacterOrder = {
  order_id: number;
  type_id: number;
  region_id: number;
  location_id: number;
  range: string;
  is_buy_order?: boolean;
  price: number;
  volume_total: number;
  volume_remain: number;
  issued: string;
  duration: number;
  min_volume?: number;
};

export type OrderRow = Omit<Standing, "status"> & {
  orderId: number;
  characterId: number;
  typeId: number;
  typeName: string;
  side: "buy" | "sell";
  locationId: number;
  location: string;
  region: string;
  price: number;
  volumeTotal: number;
  volumeRemain: number;
  issued: string;
  expires: string;
  range: string;
  // Unknown when the book could not be read; `note` says why.
  status: Status | "unknown";
  note: string | null;
  bookAsOf: string | null;
  // Corp members' orders ahead of this one; null when none are, or this character does not share.
  corp: CorpAhead | null;
  // The profile's other orders (any of its characters) priced ahead of this one; null when none are.
  own: OwnAhead | null;
  // Reprocess floor (sell) or ceiling (buy) at the order's station; null when the item does not
  // reprocess or its materials have no buyers there.
  reprocess: OrderFloor | null;
};

export type OrderFloor = Floor & {
  // The rates it was worked out with, as fractions.
  reprocessingTax: number;
  salesTax: number;
  // What had to be assumed for want of data, in words.
  assumed: string[];
};

export type OrderCharacter = {
  id: number;
  name: string;
  allowed: boolean;
  sharing: boolean;
  error: string | null;
  orders: number;
  // ESI's cache headers for the character's order list (ISO); null when not read or not sent.
  ordersAsOf: string | null;
  ordersNextRefresh: string | null;
};

export type OrdersReport = { characters: OrderCharacter[]; orders: OrderRow[]; warnings: string[]; checkedAt: number };

const isStructure = (locationId: number) => locationId >= FIRST_STRUCTURE_ID;

type EsiStation = { owner?: number; reprocessing_efficiency?: number; reprocessing_stations_take?: number };

/** Where an order would be reprocessed: the facility's base yield, its tax before standings, and its owner. */
type Facility = { base: number; take: number; owner: number | null; assumed: string | null };

// A structure's owner sets its tax, which ESI does not publish; with no rigs its base yield is 50%.
const STRUCTURE_FACILITY: Facility = { base: 0.5, take: 0, owner: null, assumed: "the structure's reprocessing tax is not published: 0% assumed" };

/** Reprocessing at each order location: Jita and structures as the calculator has them, other NPC stations as ESI says. */
async function facilities(locationIds: number[], signal: AbortSignal): Promise<Map<number, Facility>> {
  const jita = HUBS.jita;
  const out = new Map<number, Facility>();
  await Promise.all(
    locationIds.map(async (locationId) => {
      if (locationId === jita.locationId) return out.set(locationId, { base: jita.baseYield, take: jita.stationTake, owner: jita.owner.id, assumed: null });
      if (isStructure(locationId)) return out.set(locationId, STRUCTURE_FACILITY);
      try {
        const station = await esi<EsiStation>(`/universe/stations/${locationId}`, { signal });
        out.set(locationId, {
          base: station.reprocessing_efficiency ?? 0.5,
          take: station.reprocessing_stations_take ?? 0.05,
          owner: station.owner ?? null,
          assumed: null,
        });
      } catch (error) {
        console.warn(`station ${locationId} could not be read`, error);
        out.set(locationId, { base: 0.5, take: 0.05, owner: null, assumed: "the station's rates could not be read: 50% yield and 5% tax assumed" });
      }
    }),
  );
  return out;
}

function reprocessSkills(character: CharacterData): ReprocessSkills {
  const level = (skill: number) => character.skills[skill] ?? 0;
  return { scrapmetal: level(SKILL.scrapmetal), reprocessing: level(SKILL.reprocessing), efficiency: level(SKILL.efficiency), ore: character.skills };
}

/** Sales tax and the facility's reprocessing tax for one character, as the calculator estimates them. */
function characterTaxes(facility: Facility, character: CharacterData | null): { reprocessingTax: number; salesTax: number } {
  const level = (skill: number) => character?.skills[skill] ?? 0;
  const standing =
    character && facility.owner !== null && facility.owner in character.standings
      ? effectiveStanding(character.standings[facility.owner], level(SKILL.connections), level(SKILL.diplomacy))
      : 0;
  return { reprocessingTax: npcReprocessingTax(facility.take, standing), salesTax: salesTax(level(SKILL.accounting)) };
}

function expiry(order: EsiCharacterOrder): string {
  return new Date(new Date(order.issued).getTime() + order.duration * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * `fresh` (the Sync now button) re-reads order books older than a minute, and structure markets older
 * than five, instead of the usual five and fifteen.
 */
export async function openOrders(userId: string, options: { fresh?: boolean; signal?: AbortSignal } = {}): Promise<OrdersReport> {
  const signal = deadlineSignal(OPERATION_TIMEOUT_MS, options.signal);
  const profile = await listCharacters(userId);
  const characters: OrderCharacter[] = profile.map((c) => {
    const allowed = hasFeature(c.scopes, "orders");
    return { id: c.id, name: c.name, allowed, sharing: allowed && c.shareOrdersWithCorp, error: null, orders: 0, ordersAsOf: null, ordersNextRefresh: null };
  });

  const read = await Promise.all(
    characters.map(async (character) => {
      if (!character.allowed) return [];
      try {
        const token = await characterAccessToken(userId, character.id, "orders", signal);
        const { data: orders, lastModified, expires } = await esiCached<EsiCharacterOrder[]>(`/characters/${character.id}/orders`, { token, signal });
        character.ordersAsOf = lastModified?.toISOString() ?? null;
        character.ordersNextRefresh = expires?.toISOString() ?? null;
        if (!Array.isArray(orders)) throw new Error("orders are not a list");
        character.orders = orders.length;
        if (character.sharing) {
          // Best effort: corp members fall back to reading this character themselves when the snapshot is stale.
          await saveSharedOrders(character.id, toShared(orders)).catch((error) => console.warn(`could not keep shared orders of ${character.id}`, error));
        }
        return orders.map((order) => ({ ...order, characterId: character.id }));
      } catch (error) {
        character.allowed = !(error instanceof ConsentMissingError);
        character.error =
          error instanceof ConsentMissingError
            ? "Order access was revoked in EVE; allow it again on Characters"
            : error instanceof Error
              ? error.message
              : String(error);
        if (!(error instanceof ConsentMissingError)) console.warn(`order read failed for character ${character.id}`, error);
        return [];
      }
    }),
  );
  const orders = read.flat();
  if (orders.length === 0) return { characters, orders: [], warnings: [], checkedAt: Date.now() };

  const corporationOf = new Map(profile.map((c) => [c.id, c.corporationId]));
  const sharing = new Set(characters.filter((c) => c.sharing).map((c) => c.id));
  const corp = await corpOrders(
    userId,
    profile.map((c) => ({ id: c.id, userId, corporationId: c.corporationId, shareOrdersWithCorp: sharing.has(c.id), ordersAllowed: sharing.has(c.id) })),
    signal,
  ).catch((error) => {
    console.warn("corp order matching failed", error);
    return [];
  });

  const regionIds = [...new Set(orders.map((o) => o.region_id))];
  const stationIds = [...new Set(orders.map((o) => o.location_id).filter((id) => !isStructure(id)))];
  const [names, types] = await Promise.all([entityNames([...regionIds, ...stationIds]), typeNames([...new Set(orders.map((o) => o.type_id))], signal)]);
  const regionName = (id: number) => names[id] ?? `Region ${id}`;
  const locationName = (order: EsiCharacterOrder) => {
    if (order.location_id === HUBS["4-hwwf"].locationId) return HUBS["4-hwwf"].station;
    if (isStructure(order.location_id)) return `Player structure in ${regionName(order.region_id)}`;
    return names[order.location_id] ?? `Station ${order.location_id}`;
  };

  // One book read per location (and type), one history read per region and type, however many orders share them.
  const byLocation = new Map<number, typeof orders>();
  for (const order of orders) byLocation.set(order.location_id, [...(byLocation.get(order.location_id) ?? []), order]);
  const warnings: string[] = [];
  const books = new Map<number, HubPrices>();
  // Recipes of the items that reprocess, and their materials' books at each station, for the floors.
  const recipes = new Map<number, Reprocessing>();
  for (const typeId of new Set(orders.map((o) => o.type_id))) {
    const recipe = reprocessing(typeId);
    if (recipe) recipes.set(typeId, recipe);
  }
  const materialBooks = new Map<number, Map<number, Book>>();
  const reprocessed = [...byLocation].filter(([, here]) => here.some((o) => recipes.has(o.type_id))).map(([locationId]) => locationId);
  // Skills and standings of the characters with orders to floor (the stations' owners known first), alongside the books.
  const rates = (async () => {
    const at = await facilities(reprocessed, signal);
    const owners = [...new Set([...at.values()].map((f) => f.owner).filter((id) => id !== null))];
    const who = new Set(orders.filter((o) => recipes.has(o.type_id)).map((o) => o.characterId));
    const read = new Map<number, CharacterData | null>();
    await Promise.all(
      profile
        .filter((c) => who.has(c.id))
        .map(async (c) => {
          if (!hasFeature(c.scopes, "skills")) return read.set(c.id, null);
          try {
            read.set(c.id, await characterRates(userId, c.id, c.name, { owners, signal }));
          } catch (error) {
            if (!(error instanceof ConsentMissingError)) console.warn(`skills read failed for character ${c.id}`, error);
            read.set(c.id, null);
          }
        }),
    );
    return { facilities: at, characters: read };
  })();
  await Promise.all(
    [...byLocation].map(async ([locationId, here]) => {
      const structure = isStructure(locationId);
      const hub = locationId === HUBS["4-hwwf"].locationId;
      const location: MarketLocation = {
        locationId,
        regionId: here[0].region_id,
        label: hub ? HUBS["4-hwwf"].label : locationName(here[0]),
        structure,
        // Anyone's market reader may serve the hub; for any other structure, only the viewer's own characters are known to dock there.
        ownReadersOnly: structure && !hub,
      };
      const itemIds = [...new Set(here.map((o) => o.type_id))];
      const materialIds = [...new Set(itemIds.flatMap((typeId) => recipes.get(typeId)?.materials.map(([m]) => m) ?? []))].filter(
        (typeId) => !itemIds.includes(typeId),
      );
      const maxAgeMs = options.fresh
        ? structure
          ? FRESH_STRUCTURE_MAX_AGE_MS
          : FRESH_BOOK_MAX_AGE_MS
        : structure
          ? STRUCTURE_MAX_AGE_MS
          : BOOK_MAX_AGE_MS;
      // A structure's market is read whole, so one read covers the materials too (two at once would
      // trip over each other's lease). At a station, materials are read per type, and a floor does
      // not need them as fresh as the books orders are checked against.
      const [prices, materials] = await Promise.all([
        locationPrices(location, structure ? [...itemIds, ...materialIds] : itemIds, userId, { signal, maxAgeMs }).catch((error: unknown) => {
          console.warn(`order book read failed at ${locationId}`, error);
          warnings.push(`Could not read the market at ${location.label}.`);
          return null;
        }),
        structure || materialIds.length === 0
          ? null
          : locationPrices(location, materialIds, userId, { signal }).catch((error: unknown) => {
              console.warn(`material prices read failed at ${locationId}`, error);
              warnings.push(`Could not read material prices at ${location.label}; reprocess floors there are missing.`);
              return null;
            }),
      ]);
      if (prices) {
        books.set(locationId, prices);
        warnings.push(...prices.warnings);
      }
      const forMaterials = structure ? prices : materials;
      if (forMaterials?.available) {
        materialBooks.set(locationId, forMaterials.books);
        if (!structure) warnings.push(...forMaterials.warnings);
      }
    }),
  );
  const pace = new Map<number, Map<number, number>>();
  await Promise.all(
    regionIds.map(async (regionId) => {
      const typeIds = [...new Set(orders.filter((o) => o.region_id === regionId).map((o) => o.type_id))];
      try {
        const { pace: perType } = await regionPace(regionId, regionName(regionId), typeIds, signal);
        pace.set(regionId, new Map([...perType].map(([typeId, p]) => [typeId, p.volume])));
      } catch (error) {
        console.warn(`market history read failed in region ${regionId}`, error);
      }
    }),
  );

  const { facilities: facilityAt, characters: ratesOf } = await rates;
  const nameOf = new Map(profile.map((c) => [c.id, c.name]));
  const floorOf = (order: (typeof orders)[number]): OrderFloor | null => {
    const recipe = recipes.get(order.type_id);
    const materials = materialBooks.get(order.location_id);
    const facility = facilityAt.get(order.location_id);
    if (!recipe || !materials || !facility) return null;
    const character = ratesOf.get(order.characterId) ?? null;
    const taxes = characterTaxes(facility, character);
    const floor = reprocessFloor({
      side: order.is_buy_order ? "buy" : "sell",
      price: order.price,
      units: order.volume_remain,
      reprocess: recipe,
      books: materials,
      yields: facilityYields(facility.base, character ? reprocessSkills(character) : NO_SKILLS),
      ...taxes,
    });
    if (!floor) return null;
    const assumed = [
      character
        ? null
        : `${nameOf.get(order.characterId) ?? "This character"} does not allow reading skills and standings: no skills assumed`,
      facility.assumed,
      recipe.oreSkill !== null ? "no implant or structure rigs" : null,
    ].filter((a) => a !== null);
    return { ...floor, ...taxes, assumed };
  };

  const rows: OrderRow[] = orders.map((order) => {
    const isBuy = Boolean(order.is_buy_order);
    const prices = books.get(order.location_id);
    const book = prices?.available ? prices.books.get(order.type_id) : undefined;
    const base = {
      orderId: order.order_id,
      characterId: order.characterId,
      typeId: order.type_id,
      typeName: types.get(order.type_id) ?? `Type ${order.type_id}`,
      side: isBuy ? ("buy" as const) : ("sell" as const),
      locationId: order.location_id,
      location: locationName(order),
      region: regionName(order.region_id),
      price: order.price,
      volumeTotal: order.volume_total,
      volumeRemain: order.volume_remain,
      issued: order.issued,
      expires: expiry(order),
      range: order.range,
      bookAsOf: prices?.asOf?.toISOString() ?? null,
    };
    // Every open order of the profile on the same side at this station is a sibling, not competition.
    const siblings = orders
      .filter((o) => o.location_id === order.location_id && o.type_id === order.type_id && Boolean(o.is_buy_order) === isBuy)
      .map((o) => ({ orderId: o.order_id, characterId: o.characterId, price: o.price, remain: o.volume_remain }));
    if (!book) {
      const why = isStructure(order.location_id)
        ? "Structure market not readable: a character of yours that can dock there must allow market reading"
        : "Order book not available right now";
      const own = ownAhead({ orderId: order.order_id, isBuy, price: order.price }, siblings, null);
      return { ...base, status: "unknown", note: why, bestOther: null, unitsAhead: 0, daysAhead: null, suggest: null, corp: null, own, reprocess: floorOf(order) };
    }
    const others = competitors(isBuy ? book.buy : book.sell, siblings);
    const own = ownAhead({ orderId: order.order_id, isBuy, price: order.price }, siblings, others[0]?.[0] ?? null);
    const perDay = pace.get(order.region_id)?.get(order.type_id) ?? null;
    // Only a sharing character is told about corp members, and only about those in its own corporation.
    const corporationId = corporationOf.get(order.characterId);
    const theirs = sharing.has(order.characterId)
      ? corp.filter((o) => o.corporationId === corporationId && o.locationId === order.location_id && o.typeId === order.type_id && o.isBuy === isBuy)
      : [];
    return {
      ...base,
      ...standing(isBuy, order.price, order.volume_remain, others, perDay),
      note: null,
      corp: theirs.length > 0 ? corpAhead(isBuy, order.price, others, theirs) : null,
      own,
      reprocess: floorOf(order),
    };
  });
  return { characters, orders: rows, warnings: [...new Set(warnings)], checkedAt: Date.now() };
}
