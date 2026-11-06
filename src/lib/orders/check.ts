import "server-only";
import { listCharacters } from "@/lib/auth/accounts";
import { characterAccessToken, ConsentMissingError } from "@/lib/auth/tokens";
import { deadlineSignal, OPERATION_TIMEOUT_MS } from "@/lib/eve/deadline";
import { esi } from "@/lib/eve/esi";
import { entityNames } from "@/lib/eve/names";
import { hasFeature } from "@/lib/eve/sso";
import { typeNames } from "@/lib/eve/types";
import { regionPace } from "@/lib/industry/history";
import { HUBS } from "@/lib/industry/hubs";
import { type HubPrices, locationPrices, type MarketLocation } from "@/lib/industry/market";
import { competitors, type Standing, standing, type Status } from "./standing";

/**
 * Open market orders of a profile's characters and where each stands in its station's book, read
 * live when the owner opens the page: nothing here is stored except the public order books, which
 * are cached like the calculator's. Same idea as eve-skills' `orders --check`.
 */

// ESI caches order books for 5 minutes: fresher than that is not possible, older hides an undercut.
const BOOK_MAX_AGE_MS = 5 * 60 * 1000;
// A structure's market is read whole (tens of thousands of orders): not more often than the calculator does.
const STRUCTURE_MAX_AGE_MS = 15 * 60 * 1000;
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
};

export type OrderCharacter = { id: number; name: string; allowed: boolean; error: string | null; orders: number };

export type OrdersReport = { characters: OrderCharacter[]; orders: OrderRow[]; warnings: string[]; checkedAt: number };

const isStructure = (locationId: number) => locationId >= FIRST_STRUCTURE_ID;

function expiry(order: EsiCharacterOrder): string {
  return new Date(new Date(order.issued).getTime() + order.duration * 24 * 60 * 60 * 1000).toISOString();
}

export async function openOrders(userId: string, parentSignal?: AbortSignal): Promise<OrdersReport> {
  const signal = deadlineSignal(OPERATION_TIMEOUT_MS, parentSignal);
  const profile = await listCharacters(userId);
  const characters: OrderCharacter[] = profile.map((c) => ({ id: c.id, name: c.name, allowed: hasFeature(c.scopes, "orders"), error: null, orders: 0 }));

  const read = await Promise.all(
    characters.map(async (character) => {
      if (!character.allowed) return [];
      try {
        const token = await characterAccessToken(userId, character.id, "orders", signal);
        const orders = await esi<EsiCharacterOrder[]>(`/characters/${character.id}/orders`, { token, signal });
        if (!Array.isArray(orders)) throw new Error("orders are not a list");
        character.orders = orders.length;
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
      try {
        const prices = await locationPrices(location, here.map((o) => o.type_id), userId, {
          signal,
          maxAgeMs: structure ? STRUCTURE_MAX_AGE_MS : BOOK_MAX_AGE_MS,
        });
        books.set(locationId, prices);
        warnings.push(...prices.warnings);
      } catch (error) {
        console.warn(`order book read failed at ${locationId}`, error);
        warnings.push(`Could not read the market at ${location.label}.`);
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
    if (!book) {
      const why = isStructure(order.location_id)
        ? "Structure market not readable: a character of yours that can dock there must allow market reading"
        : "Order book not available right now";
      return { ...base, status: "unknown", note: why, bestOther: null, unitsAhead: 0, daysAhead: null, suggest: null };
    }
    // Every open order of the profile on the same side at this station is a sibling, not competition.
    const siblings = orders
      .filter((o) => o.location_id === order.location_id && o.type_id === order.type_id && Boolean(o.is_buy_order) === isBuy)
      .map((o) => ({ price: o.price, remain: o.volume_remain }));
    const others = competitors(isBuy ? book.buy : book.sell, siblings);
    const perDay = pace.get(order.region_id)?.get(order.type_id) ?? null;
    return { ...base, ...standing(isBuy, order.price, order.volume_remain, others, perDay), note: null };
  });
  return { characters, orders: rows, warnings: [...new Set(warnings)], checkedAt: Date.now() };
}
