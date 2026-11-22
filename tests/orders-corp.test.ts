import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { characters, users } from "@/db/schema";
import { openOrders } from "@/lib/orders/check";

// openOrders end to end, EVE mocked: a sell order undercut at 4-HWWF by a corp member who shares too
// (the case checked in production on 2026-11-22).
const HWWF = 1053970513596;
const AB = 12076;
vi.mock("@/lib/auth/tokens", async (orig) => ({ ...(await orig<typeof import("@/lib/auth/tokens")>()), characterAccessToken: vi.fn(async () => "tok") }));
const characterOrders = (path: string) => {
  if (path === "/characters/1/orders")
    return [{ order_id: 9, type_id: AB, region_id: 10000003, location_id: HWWF, range: "region", price: 152000, volume_total: 5, volume_remain: 5, issued: "2026-11-22T13:00:00Z", duration: 90 }];
  if (path === "/characters/2/orders")
    return [{ order_id: 8, type_id: AB, region_id: 10000003, location_id: HWWF, range: "region", price: 148900, volume_total: 3, volume_remain: 3, issued: "2026-11-22T13:00:00Z", duration: 90 }];
  throw new Error(`unexpected ${path}`);
};
vi.mock("@/lib/eve/esi", async (orig) => ({
  ...(await orig<typeof import("@/lib/eve/esi")>()),
  affiliations: vi.fn(async () => []),
  esi: vi.fn(async (path: string) => characterOrders(path)),
  esiCached: vi.fn(async (path: string) => ({
    data: characterOrders(path),
    lastModified: new Date("2026-11-22T14:45:00Z"),
    expires: new Date("2026-11-22T15:05:00Z"),
  })),
}));
vi.mock("@/lib/industry/market", async (orig) => ({
  ...(await orig<typeof import("@/lib/industry/market")>()),
  locationPrices: vi.fn(async () => ({ books: new Map([[AB, { buy: [], sell: [[148900, 204], [149000, 646], [152000, 5]] }]]), asOf: new Date(), available: true, warnings: [] })),
}));
vi.mock("@/lib/industry/history", () => ({ regionPace: vi.fn(async () => ({ pace: new Map(), warnings: [] })) }));
vi.mock("@/lib/eve/names", async (orig) => ({ ...(await orig<typeof import("@/lib/eve/names")>()), entityNames: vi.fn(async () => ({})) }));
vi.mock("@/lib/eve/types", async (orig) => ({ ...(await orig<typeof import("@/lib/eve/types")>()), typeNames: vi.fn(async () => new Map()) }));

beforeEach(async () => {
  await db.execute(sql`TRUNCATE users, characters CASCADE`);
});

async function pilots(share: [boolean, boolean], corporations: [number, number] = [98819027, 98819027]): Promise<string[]> {
  const ids: string[] = [];
  for (const [i, id] of [1, 2].entries()) {
    const [u] = await db.insert(users).values({}).returning();
    ids.push(u.id);
    await db.insert(characters).values({
      id,
      userId: u.id,
      name: `Pilot ${id}`,
      ownerHash: `owner-${id}`,
      corporationId: corporations[i],
      affiliationCheckedAt: new Date(),
      scopes: ["esi-markets.read_character_orders.v1"],
      refreshTokenEnc: "x",
      shareOrdersWithCorp: share[i],
    });
  }
  return ids;
}

describe("openOrders with corp sharing", () => {
  it("marks an order a sharing corp member undercuts, reading their orders when none are kept", async () => {
    const [me] = await pilots([true, true]);
    const report = await openOrders(me);
    expect(report.orders[0]).toMatchObject({ status: "undercut", bestOther: 148900, corp: { units: 3, holdsBest: true } });
    // ESI's cache headers say how old the order list is, apart from when the page asked.
    expect(report.characters[0]).toMatchObject({ ordersAsOf: "2026-11-22T14:45:00.000Z", ordersNextRefresh: "2026-11-22T15:05:00.000Z" });
  });

  it("marks nothing unless both share and are in the same corporation", async () => {
    for (const [share, corporations] of [
      [[true, false], undefined],
      [[false, true], undefined],
      [[true, true], [98819027, 98000001]],
    ] as const) {
      await db.execute(sql`TRUNCATE users, characters CASCADE`);
      const [me] = await pilots([...share], corporations && [...corporations]);
      expect((await openOrders(me)).orders[0]).toMatchObject({ status: "undercut", corp: null });
    }
  });
});
