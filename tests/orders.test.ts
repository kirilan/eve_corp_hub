import { describe, expect, it } from "vitest";
import { competitors, realFloor, standing, tick, tickAbove, tickBelow } from "@/lib/orders/standing";

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
