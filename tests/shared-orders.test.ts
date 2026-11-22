import { eq, inArray, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { characters, sharedOrders, users } from "@/db/schema";
import { corpOrders } from "@/lib/orders/shared";

// Snapshots in these tests are fresh, so nothing should be read from EVE.
vi.mock("@/lib/eve/esi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/eve/esi")>()),
  esi: vi.fn(async () => {
    throw new Error("no ESI in tests");
  }),
  affiliations: vi.fn(async () => {
    throw new Error("no ESI in tests");
  }),
}));

const ORDER_SCOPES = ["esi-markets.read_character_orders.v1"];
const CORP = 98000001;

async function pilot(id: number, corporationId: number, share: boolean, scopes = ORDER_SCOPES) {
  const [user] = await db.insert(users).values({}).returning();
  await db.insert(characters).values({
    id,
    userId: user.id,
    name: `Pilot ${id}`,
    ownerHash: `owner-${id}`,
    corporationId,
    affiliationCheckedAt: new Date(),
    scopes,
    shareOrdersWithCorp: share,
  });
  await db.insert(sharedOrders).values({ characterId: id, orders: [{ locationId: 60003760, typeId: 34, isBuy: false, price: id, remain: 10 }] });
  return user.id;
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE users, characters CASCADE`);
});

describe("corpOrders", () => {
  it("returns only opted-in corp members on other profiles", async () => {
    const me = await pilot(1, CORP, true);
    await pilot(2, CORP, true); // shares, same corp: matched
    await pilot(3, 98000002, true); // other corp
    await pilot(4, CORP, false); // does not share
    await pilot(5, CORP, true, []); // shares, but order tracking was revoked
    const mine = [{ id: 1, userId: me, corporationId: CORP, shareOrdersWithCorp: true, ordersAllowed: true }];
    const found = await corpOrders(me, mine, new AbortController().signal);
    expect(found.map((o) => o.price)).toEqual([2]);
    expect(found[0]).toMatchObject({ corporationId: CORP, typeId: 34 });
  });

  it("returns nothing unless the viewer shares too", async () => {
    const me = await pilot(1, CORP, false);
    await pilot(2, CORP, true);
    const mine = [{ id: 1, userId: me, corporationId: CORP, shareOrdersWithCorp: false, ordersAllowed: true }];
    expect(await corpOrders(me, mine, new AbortController().signal)).toEqual([]);
  });

  it("drops a stale snapshot whose owner no longer allows order reading", async () => {
    const me = await pilot(1, CORP, true);
    await pilot(2, CORP, true);
    await db.update(sharedOrders).set({ fetchedAt: new Date(Date.now() - 60 * 60_000) }).where(inArray(sharedOrders.characterId, [2]));
    const mine = [{ id: 1, userId: me, corporationId: CORP, shareOrdersWithCorp: true, ordersAllowed: true }];
    // No refresh token stored: the read fails as missing consent and the snapshot is dropped.
    expect(await corpOrders(me, mine, new AbortController().signal)).toEqual([]);
    expect(await db.$count(sharedOrders, eq(sharedOrders.characterId, 2))).toBe(0);
  });
});
