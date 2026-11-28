import { describe, expect, it } from "vitest";
import { facilityYields, NO_SKILLS, reprocessFloor } from "@/lib/orders/floor";

// One unit reprocesses into 100 Tritanium (34) and 10 Pyerite (35).
const module_ = { portionSize: 1, materials: [[34, 100], [35, 10]] as [number, number][], oreSkill: null };
const books = new Map([
  [34, { buy: [[4, 1_000_000]] as [number, number][], sell: [] }],
  [35, { buy: [[10, 1_000_000]] as [number, number][], sell: [] }],
]);
const at50 = facilityYields(0.5, NO_SKILLS);

describe("reprocess floor", () => {
  it("prices one unit's materials in the station's buy orders, after yield and tax", () => {
    // 50% yield, no tax: 50 Tritanium × 4 + 5 Pyerite × 10 = 250 ISK a unit.
    const floor = reprocessFloor({ side: "sell", price: 300, units: 10, reprocess: module_, books, yields: at50, reprocessingTax: 0, salesTax: 0.075 });
    expect(floor).toMatchObject({ kind: "floor", price: 250, ratio: 1.2, rate: 0.5, partial: false });
  });

  it("takes sales tax off a buy order's ceiling, and the station's reprocessing tax off both", () => {
    const ceiling = reprocessFloor({ side: "buy", price: 200, units: 10, reprocess: module_, books, yields: at50, reprocessingTax: 0.05, salesTax: 0.1 });
    // Ten units at 47.5%: 475 Tritanium and 47 Pyerite (EVE rounds each material down), 237 ISK a unit, 213.3 after 10% sales tax.
    expect(ceiling?.kind).toBe("ceiling");
    expect(ceiling?.price).toBeCloseTo(213.3);
    expect(ceiling?.ratio).toBeCloseTo(200 / 213.3);
  });

  it("uses Scrapmetal Processing for items and the ore skills for ore", () => {
    const skilled = facilityYields(0.5, { scrapmetal: 5, reprocessing: 5, efficiency: 5, ore: { 60377: 4 } });
    expect(skilled.scrap).toBeCloseTo(0.55);
    expect(skilled.ore(60377)).toBeCloseTo(0.5 * 1.15 * 1.1 * 1.08);
    expect(skilled.ore(99999)).toBeCloseTo(0.5 * 1.15 * 1.1);
  });

  it("counts units short of a portion pro rata, and walks down the buy book", () => {
    const ammo = { portionSize: 100, materials: [[34, 1000]] as [number, number][], oreSkill: null };
    const thin = new Map([[34, { buy: [[5, 500], [1, 1_000_000]] as [number, number][], sell: [] }]]);
    // 150 rounds at 50%: 750 Tritanium, 500 at 5 and 250 at 1 = 2750 ISK, 18.33 a round.
    const floor = reprocessFloor({ side: "sell", price: 20, units: 150, reprocess: ammo, books: thin, yields: at50, reprocessingTax: 0, salesTax: 0 });
    expect(floor?.price).toBeCloseTo(2750 / 150);
  });

  it("says when buyers take only part of the materials, and gives none without buyers", () => {
    const short = new Map([[34, { buy: [[4, 10]] as [number, number][], sell: [] }]]);
    expect(reprocessFloor({ side: "sell", price: 1, units: 1, reprocess: module_, books: short, yields: at50, reprocessingTax: 0, salesTax: 0 })).toMatchObject({
      price: 40,
      partial: true,
    });
    expect(reprocessFloor({ side: "sell", price: 1, units: 1, reprocess: module_, books: new Map(), yields: at50, reprocessingTax: 0, salesTax: 0 })).toBeNull();
  });
});
