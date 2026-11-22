import { describe, expect, it } from "vitest";
import { competitors, corpAhead, ownAhead, realFloor, standing, tick, tickAbove, tickBelow } from "@/lib/orders/standing";
import { type OrderSharer, sharesOrdersWith } from "@/lib/permissions";

describe("ticks", () => {
  it("steps at the fourth significant digit, a cent at least", () => {
    expect(tick(3_325_000)).toBe(1000);
    expect(tickBelow(3_325_000)).toBe(3_324_000);
    expect(tickBelow(1_000_000)).toBe(999_000);
    expect(tickAbove(999_900)).toBe(1_000_000);
    expect(tickBelow(912.1)).toBe(912);
    expect(tickBelow(0.01)).toBe(0.01);
    expect(tick(5)).toBe(0.01);
  });
});

describe("standing", () => {
  it("calls a sell order cheapest, undercut, or behind a thin sliver it should ignore", () => {
    expect(standing(false, 100, 10, [[101, 50]], 100)).toMatchObject({ status: "cheapest", bestOther: 101, unitsAhead: 0, suggest: null });
    expect(standing(false, 100, 10, [[99, 50], [101, 5]], 100)).toMatchObject({ status: "undercut", unitsAhead: 50, daysAhead: 0.5, suggest: 98.99 });
    // One unit far below the rest, on a 100-unit stack: a sliver, not worth undercutting.
    const sliver = standing(false, 100, 100, [[80, 1], [99.5, 40]], 1000);
    expect(sliver.status).toBe("undercut");
    expect(sliver.suggest).toBe(99.49);
    expect(realFloor([[80, 1], [99.5, 40]], 1000, 100)).toBe(1);
    expect(standing(false, 99.49, 100, [[80, 1], [99.5, 40]], 1000)).toMatchObject({ status: "behind sliver", suggest: null });
  });

  it("calls a buy order top or outbid, and alone without competition", () => {
    expect(standing(true, 50, 10, [[49, 100]], null)).toMatchObject({ status: "top", daysAhead: null });
    expect(standing(true, 50, 10, [[51, 100], [49, 3]], 20)).toMatchObject({ status: "outbid", unitsAhead: 100, daysAhead: 5, suggest: 51.01 });
    expect(standing(true, 50, 10, [], 20)).toMatchObject({ status: "alone", bestOther: null });
  });

  it("never counts the profile's own orders as competition", () => {
    expect(competitors([[99, 10], [100, 30]], [{ price: 99, remain: 10 }, { price: 100, remain: 5 }])).toEqual([[100, 25]]);
    expect(standing(false, 100, 5, competitors([[99, 10], [100, 30]], [{ price: 99, remain: 10 }, { price: 100, remain: 5 }]), null).status).toBe("cheapest");
  });
});

describe("corp competitors", () => {
  it("counts corp orders priced ahead only while the live book still holds them", () => {
    // Sell at 100; a corp member sells at 99 (the best price) and 99.5, someone else at 99.5 too.
    expect(corpAhead(false, 100, [[99, 10], [99.5, 30]], [{ price: 99, remain: 10 }, { price: 99.5, remain: 5 }])).toEqual({ units: 15, holdsBest: true });
    // The corp order at 98 is gone from the book (filled or changed since the snapshot).
    expect(corpAhead(false, 100, [[99, 10]], [{ price: 98, remain: 10 }])).toBeNull();
    // Never more units than the book shows at that price.
    expect(corpAhead(false, 100, [[99, 4]], [{ price: 99, remain: 10 }])).toEqual({ units: 4, holdsBest: true });
    // Behind the best price, or behind us, it is not the one undercutting.
    expect(corpAhead(false, 100, [[98, 5], [99, 10]], [{ price: 99, remain: 10 }])).toEqual({ units: 10, holdsBest: false });
    expect(corpAhead(false, 100, [[101, 10]], [{ price: 101, remain: 10 }])).toBeNull();
  });

  it("looks upward for buy orders", () => {
    expect(corpAhead(true, 50, [[51, 20], [49, 5]], [{ price: 51, remain: 20 }])).toEqual({ units: 20, holdsBest: true });
    expect(corpAhead(true, 50, [[51, 20], [49, 5]], [{ price: 49, remain: 5 }])).toBeNull();
  });

  it("matches only two opted-in characters of the same corporation on different profiles", () => {
    const sharer = (userId: string, corporationId: number | null = 1, over: Partial<OrderSharer> = {}): OrderSharer => ({
      userId,
      corporationId,
      shareOrdersWithCorp: true,
      ordersAllowed: true,
      ...over,
    });
    expect(sharesOrdersWith(sharer("a"), sharer("b"))).toBe(true);
    expect(sharesOrdersWith(sharer("a"), sharer("a"))).toBe(false);
    expect(sharesOrdersWith(sharer("a"), sharer("b", 2))).toBe(false);
    expect(sharesOrdersWith(sharer("a", null), sharer("b", null))).toBe(false);
    expect(sharesOrdersWith(sharer("a", 1, { shareOrdersWithCorp: false }), sharer("b"))).toBe(false);
    expect(sharesOrdersWith(sharer("a"), sharer("b", 1, { shareOrdersWithCorp: false }))).toBe(false);
    expect(sharesOrdersWith(sharer("a"), sharer("b", 1, { ordersAllowed: false }))).toBe(false);
  });
});

describe("own competitors", () => {
  const sib = (orderId: number, characterId: number, price: number, remain = 5) => ({ orderId, characterId, price, remain });
  it("finds the profile's other orders priced ahead, skipping the order itself", () => {
    const siblings = [sib(1, 10, 100), sib(2, 11, 99), sib(3, 12, 98, 2), sib(4, 13, 101)];
    expect(ownAhead({ orderId: 1, isBuy: false, price: 100 }, siblings, 98.5)).toEqual({ units: 7, characterIds: [11, 12], holdsBest: true });
    expect(ownAhead({ orderId: 2, isBuy: false, price: 99 }, siblings, 97)).toEqual({ units: 2, characterIds: [12], holdsBest: false });
    expect(ownAhead({ orderId: 3, isBuy: false, price: 98 }, siblings, 97)).toBeNull();
  });
  it("works for buy orders, with no competition, and for the same character", () => {
    const siblings = [sib(1, 10, 50), sib(2, 10, 51)];
    expect(ownAhead({ orderId: 1, isBuy: true, price: 50 }, siblings, null)).toEqual({ units: 5, characterIds: [10], holdsBest: true });
    expect(ownAhead({ orderId: 2, isBuy: true, price: 51 }, siblings, null)).toBeNull();
    // Same price is not ahead.
    expect(ownAhead({ orderId: 1, isBuy: true, price: 50 }, [sib(1, 10, 50), sib(2, 11, 50)], 49)).toBeNull();
  });
});
