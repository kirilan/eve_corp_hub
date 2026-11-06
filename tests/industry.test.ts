import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { marketPrices, marketSnapshots } from "@/db/schema";
import { completeSignIn } from "@/lib/auth/accounts";
import { ConsentMissingError } from "@/lib/auth/tokens";
import { EsiError } from "@/lib/eve/esi";
import { FEATURE_SCOPES, featuresWith } from "@/lib/eve/sso";
import { typesByName } from "@/lib/eve/types";
import type { TypeInfo } from "@/lib/fittings/eft";
import { AppraisalError, appraiseItems, MAX_INPUT_LINES } from "@/lib/industry/appraisal";
import { HUBS } from "@/lib/industry/hubs";
import { booksFrom, type EsiOrder, hubPrices, PRICE_MAX_AGE_MS, structureMarketStatus } from "@/lib/industry/market";
import { characterRates } from "@/lib/industry/character";
import { ORE_SKILL_NAMES, reprocessing } from "@/lib/industry/materials";
import { parseItemList, quantityOf } from "@/lib/industry/parse";
import {
  ALL_V,
  type CharacterData,
  defaultHubSettings,
  defaultSettings,
  effectiveStanding,
  fromCharacter,
  type HubSettings,
  npcBrokerFee,
  npcReprocessingTax,
  oreBaseYield,
  oreYield,
  SKILL,
  salesTax,
  scrapYield,
} from "@/lib/industry/rates";
import {
  type Appraisal,
  appraise,
  type AppraisalItem,
  type Basis,
  keptShare,
  type OptionKey,
  type Pricing,
  reprocessStack,
  saleValue,
  type Yields,
} from "@/lib/industry/reprocess";

const characterAccessToken = vi.hoisted(() => vi.fn<(userId: string, characterId: number, feature: string) => Promise<string>>(async () => "token"));
vi.mock("@/lib/auth/tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/tokens")>()),
  characterAccessToken,
}));
const esiPages = vi.hoisted(() => vi.fn<(path: string, init?: { token?: string; maxPages?: number }) => Promise<unknown[]>>());
const esi = vi.hoisted(() => vi.fn<(path: string, init?: { token?: string }) => Promise<unknown>>());
vi.mock("@/lib/eve/esi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/eve/esi")>()),
  esiPages,
  esi,
  affiliations: vi.fn(async () => []),
}));
// Real ids, names and groups, so the reprocessing table answers for them as it does in the game.
const TYPES: TypeInfo[] = [
  { id: 2048, name: "Damage Control II", groupId: 60, categoryId: 7, slot: "lo" },
  { id: 185, name: "EMP S", groupId: 83, categoryId: 8, slot: null },
  { id: 1230, name: "Veldspar", groupId: 462, categoryId: 25, slot: null },
  { id: 2488, name: "Warrior II", groupId: 100, categoryId: 18, slot: null },
  { id: 44992, name: "PLEX", groupId: 1875, categoryId: 63, slot: null },
  { id: 34, name: "Tritanium", groupId: 18, categoryId: 4, slot: null },
  { id: 35, name: "Pyerite", groupId: 18, categoryId: 4, slot: null },
  { id: 38, name: "Nocxium", groupId: 18, categoryId: 4, slot: null },
];
vi.mock("@/lib/eve/types", () => ({
  typesByName: vi.fn(async (names: string[]) => {
    const wanted = new Set(names.map((name) => name.toLowerCase()));
    return new Map(TYPES.filter((type) => wanted.has(type.name.toLowerCase())).map((type) => [type.name.toLowerCase(), type]));
  }),
  typeNames: vi.fn(async (ids: number[]) => new Map(ids.map((id) => [id, TYPES.find((type) => type.id === id)?.name ?? `Type ${id}`]))),
}));

const JITA = HUBS.jita.locationId;
const HWWF = HUBS["4-hwwf"].locationId;
const MARKETS = [...FEATURE_SCOPES.markets];

async function profile(characterId: number, scopes: string[] = MARKETS): Promise<string> {
  const { userId } = await completeSignIn({
    intent: "login",
    currentUserId: null,
    verified: { characterId, name: `Pilot ${characterId}`, ownerHash: `h${characterId}`, scopes, expiresAt: new Date() },
    tokens: { access_token: "a", refresh_token: "r", expires_in: 1199 },
    affiliation: null,
  });
  return userId;
}

const order = (typeId: number, price: number, volume: number, buy: boolean, location: number = JITA): EsiOrder => ({
  type_id: typeId,
  location_id: location,
  is_buy_order: buy,
  price,
  volume_remain: volume,
});

beforeEach(async () => {
  await db.execute(sql`TRUNCATE users, characters, market_prices, market_snapshots CASCADE`);
  esiPages.mockReset();
  esi.mockReset();
  characterAccessToken.mockReset();
  characterAccessToken.mockResolvedValue("token");
});

describe("consent", () => {
  it("keeps the features a character already allows when it allows market reading", () => {
    expect(featuresWith([...FEATURE_SCOPES.wallet], "markets")).toEqual(["wallet", "markets"]);
  });
});

describe("parseItemList", () => {
  const first = (text: string) => parseItemList(text).map((line) => line.readings[0]);

  it("reads EVE inventory copies: tab-separated name and quantity, blank meaning one", () => {
    expect(first("Warrior II\t5\tCombat Drone\tDrone\t\t\t25 m3\nDamage Control II\t\tDamage Control\tModule\t\tLow\t5 m3")).toEqual([
      { name: "Warrior II", quantity: 5 },
      { name: "Damage Control II", quantity: 1 },
    ]);
  });

  it("understands thousands written the ways EVE writes them in different languages", () => {
    expect(["1,234", "1.234", "1 234", "1 234", "1'234", "1234"].map(quantityOf)).toEqual([1234, 1234, 1234, 1234, 1234, 1234]);
    expect(quantityOf("12.5")).toBeNull();
    expect(quantityOf("0")).toBeNull();
  });

  it("offers every reading of a line, most likely first", () => {
    const [line] = parseItemList("Warrior II x5");
    expect(line.readings).toEqual([
      { name: "Warrior II x5", quantity: 1 },
      { name: "Warrior II", quantity: 5 },
    ]);
    expect(parseItemList("5x EMP S")[0].readings).toContainEqual({ name: "EMP S", quantity: 5 });
    expect(parseItemList("Tritanium 1,000")[0].readings).toContainEqual({ name: "Tritanium", quantity: 1000 });
    expect(parseItemList("1000 Tritanium")[0].readings).toContainEqual({ name: "Tritanium", quantity: 1000 });
  });

  it("reads an EFT fit: the hull, modules without their charges, no placeholders", () => {
    const lines = parseItemList("[Rifter, Tackle]\nDamage Control II\n[Empty Low slot]\n200mm AutoCannon II, EMP S\nWarp Disruptor II /OFFLINE");
    expect(lines.map((line) => line.readings[0])).toEqual([
      { name: "Rifter", quantity: 1 },
      { name: "Damage Control II", quantity: 1 },
      { name: "200mm AutoCannon II, EMP S", quantity: 1 },
      { name: "Warp Disruptor II", quantity: 1 },
    ]);
    expect(lines[2].readings).toContainEqual({ name: "200mm AutoCannon II", quantity: 1 });
  });

  it("keeps a line too long to be a name, so it is reported as not recognised", () => {
    const [line] = parseItemList("x".repeat(150));
    expect(line.readings).toEqual([]);
  });
});

const flat = (rate: number): Yields => ({ scrap: rate, ore: () => rate });
const noFees = (basis: Basis = "buy"): Pricing => ({ basis, reprocessingTax: 0, salesTax: 0, brokerFee: 0 });
// The two options as the user first specced them: everything at 50%, or items at 55% with ore left at 50%.
const BASE_55: Record<OptionKey, Yields> = { base: flat(0.5), skills: { scrap: 0.55, ore: () => 0.5 } };
const SIMPLE_ORE = 60377;

describe("reprocessing", () => {
  it("comes from the static data: portion size, materials, and the skill an ore uses", () => {
    expect(reprocessing(185)).toEqual({ portionSize: 100, materials: [[34, 204], [35, 17], [38, 1]], oreSkill: null });
    expect(reprocessing(1230)).toMatchObject({ portionSize: 100, oreSkill: SIMPLE_ORE });
    expect(ORE_SKILL_NAMES[SIMPLE_ORE]).toBe("Simple Ore Processing");
    expect(reprocessing(44992)).toBeNull();
  });

  const emp = (quantity: number): AppraisalItem => ({ typeId: 185, name: "EMP S", quantity, reprocess: reprocessing(185) });

  it("yields whole portions only, rounding each material down", () => {
    const { materials, leftover } = reprocessStack(emp(250), flat(0.55), 0);
    // 2 portions: 204 * 2 * 0.55 = 224.4, 17 * 2 * 0.55 = 18.7, 1 * 2 * 0.55 = 1.1
    expect(Object.fromEntries(materials)).toEqual({ 34: 224, 35: 18, 38: 1 });
    expect(leftover).toBe(50);
  });

  it("takes the station's tax out of the materials", () => {
    expect(reprocessStack(emp(100), flat(0.5), 0.1).materials.get(34)).toBe(91); // 204 * 0.5 * 0.9 = 91.8
  });

  it("reprocesses ore at its own skill's yield, not Scrapmetal Processing's", () => {
    const veldspar: AppraisalItem = { typeId: 1230, name: "Veldspar", quantity: 1000, reprocess: reprocessing(1230) };
    const yields: Yields = { scrap: 0.55, ore: (skill) => (skill === SIMPLE_ORE ? 0.6 : 0) };
    expect(reprocessStack(veldspar, yields, 0).materials.get(34)).toBe(2400); // 10 portions * 400 * 0.6
  });

  it("is not thrown off by floating point: 20 units at 55% is 11", () => {
    const item: AppraisalItem = { typeId: 1, name: "x", quantity: 1, reprocess: { portionSize: 1, materials: [[34, 20]], oreSkill: null } };
    expect(reprocessStack(item, flat(0.55), 0).materials.get(34)).toBe(11);
  });
});

describe("rates", () => {
  it("sales tax is 7.5%, less 11% of it per level of Accounting", () => {
    expect(salesTax(0)).toBeCloseTo(0.075, 10);
    expect(salesTax(5)).toBeCloseTo(0.03375, 10);
  });

  it("NPC broker fee falls with Broker Relations and plain standings, to 1% at best", () => {
    expect(npcBrokerFee(0, 0, 0)).toBeCloseTo(0.03, 10);
    expect(npcBrokerFee(5, 0, 0)).toBeCloseTo(0.015, 10);
    expect(npcBrokerFee(5, 10, 10)).toBeCloseTo(0.01, 10);
  });

  it("NPC reprocessing tax falls with standing, to nothing at 6.67", () => {
    expect(npcReprocessingTax(0.05, 0)).toBe(0.05);
    expect(npcReprocessingTax(0.05, 2)).toBeCloseTo(0.035, 10);
    expect(npcReprocessingTax(0.05, 6.67)).toBe(0);
    expect(npcReprocessingTax(0.05, 9)).toBe(0);
  });

  it("Connections lifts a positive standing towards 10, Diplomacy a negative one", () => {
    expect(effectiveStanding(0, 5, 0)).toBeCloseTo(2, 10);
    expect(effectiveStanding(-2, 5, 0)).toBe(-2);
    expect(effectiveStanding(-2, 0, 5)).toBeCloseTo(0.4, 10);
  });

  it("items get 2% of the 50% base per level of Scrapmetal Processing, at a station or a structure", () => {
    expect(scrapYield("jita", 5)).toBeCloseTo(0.55, 10);
    expect(scrapYield("4-hwwf", 4)).toBeCloseTo(0.54, 10);
  });

  it("ore multiplies the station's base by Reprocessing, Reprocessing Efficiency, its own skill and the implant", () => {
    const rx804 = { ...ALL_V, implant: 3 };
    expect(oreYield("jita", defaultHubSettings("jita"), rx804, SIMPLE_ORE)).toBeCloseTo(0.5 * 1.15 * 1.1 * 1.1 * 1.04, 10);
    expect(oreYield("jita", defaultHubSettings("jita"), { ...ALL_V, ore: { [SIMPLE_ORE]: 0 } }, SIMPLE_ORE)).toBeCloseTo(0.5 * 1.15 * 1.1, 10);
  });

  it("matches EVE University's worked example: T2-rigged Tatara in null-sec, every skill V, RX-804", () => {
    const tatara: HubSettings = { ...defaultHubSettings("4-hwwf"), structure: "tatara", rig: 2 };
    expect(oreYield("4-hwwf", tatara, { ...ALL_V, implant: 3 }, SIMPLE_ORE)).toBeCloseTo(0.90628, 5);
    // The security bonus needs a rig.
    expect(oreBaseYield("4-hwwf", { ...tatara, structure: "citadel", rig: 0 })).toBe(0.5);
  });

  it("assumes every skill at V and no standings until a character is picked", () => {
    expect(defaultHubSettings("jita")).toMatchObject({ reprocessingTax: "5", salesTax: "3.375", brokerFee: "1.5" });
    expect(defaultHubSettings("4-hwwf")).toMatchObject({ reprocessingTax: "0", salesTax: "3.375", brokerFee: "1" });
  });

  it("fills skills and rates from a character, leaving a structure's owner-set rates and the implant alone", () => {
    const character: CharacterData = {
      id: 1,
      name: "Pilot 1",
      skills: { [SKILL.scrapmetal]: 4, [SKILL.accounting]: 3, [SKILL.brokerRelations]: 4, [SKILL.connections]: 5, [SIMPLE_ORE]: 2 },
      standings: { [HUBS.jita.owner.id]: 2, [HUBS.jita.faction.id]: 5 },
    };
    const hubs = { ...defaultSettings(), "4-hwwf": { ...defaultHubSettings("4-hwwf"), reprocessingTax: "3", brokerFee: "2.5" } };
    const filled = fromCharacter(character, { skills: { ...ALL_V, implant: 2 }, hubs });
    expect(filled.skills).toMatchObject({ scrapmetal: 4, reprocessing: 0, efficiency: 0, otherOre: 0, implant: 2 });
    expect(filled.skills.ore[SIMPLE_ORE]).toBe(2);
    // Accounting III: 7.5% * 0.67, everywhere.
    expect(filled.hubs.jita.salesTax).toBe("5.025");
    expect(filled.hubs["4-hwwf"].salesTax).toBe("5.025");
    // Broker Relations IV, faction 5, corporation 2: 3 - 1.2 - 0.15 - 0.04.
    expect(filled.hubs.jita.brokerFee).toBe("1.61");
    // Connections V lifts standing 2 to 3.6: 5% * (1 - 0.15 * 3.6).
    expect(filled.hubs.jita.reprocessingTax).toBe("2.3");
    expect(filled.hubs["4-hwwf"]).toMatchObject({ reprocessingTax: "3", brokerFee: "2.5" });
  });
});

describe("saleValue", () => {
  const book = { buy: [[10, 5], [8, 10]] as [number, number][], sell: [[12, 3]] as [number, number][] };

  it("walks down the buy orders and says how much they take", () => {
    expect(saleValue(book, 3, "buy")).toEqual({ value: 30, sold: 3 });
    expect(saleValue(book, 8, "buy")).toEqual({ value: 50 + 24, sold: 8 });
    expect(saleValue(book, 20, "buy")).toEqual({ value: 50 + 80, sold: 15 });
  });

  it("prices a listing at the lowest sell order, however big", () => {
    expect(saleValue(book, 20, "sell")).toEqual({ value: 240, sold: 20 });
    expect(saleValue({ buy: [], sell: [] }, 5, "sell")).toEqual({ value: 0, sold: 0 });
  });

  it("keeps the sale less sales tax, and less the broker fee only when listing", () => {
    const rates = { reprocessingTax: 0, salesTax: 0.05, brokerFee: 0.02 };
    expect(keptShare({ basis: "buy", ...rates })).toBeCloseTo(0.95, 10);
    expect(keptShare({ basis: "sell", ...rates })).toBeCloseTo(0.93, 10);
  });
});

describe("appraise", () => {
  const appraisal = (items: AppraisalItem[], books: Appraisal["books"]): Appraisal => ({
    hub: "jita",
    items,
    materialNames: { 34: "Tritanium", 35: "Pyerite", 38: "Nocxium" },
    oreSkillNames: {},
    books,
    unknown: [],
    pricesAsOf: new Date().toISOString(),
    pricesAvailable: true,
    warnings: [],
  });
  const books = {
    185: { buy: [[1, 1000]], sell: [[2, 1000]] },
    34: { buy: [[4, 1_000_000]], sell: [[5, 1_000_000]] },
    35: { buy: [[10, 1_000_000]], sell: [[12, 1_000_000]] },
    38: { buy: [[800, 1_000_000]], sell: [[900, 1_000_000]] },
    44992: { buy: [[5_000_000, 10]], sell: [[5_500_000, 10]] },
  } satisfies Appraisal["books"];

  it("totals each option and marks the better way per item", () => {
    const items: AppraisalItem[] = [
      { typeId: 185, name: "EMP S", quantity: 1000, reprocess: reprocessing(185) },
      { typeId: 44992, name: "PLEX", quantity: 1, reprocess: null },
    ];
    const result = appraise(appraisal(items, books), noFees(), BASE_55);
    const emp = result.items.find((row) => row.typeId === 185)!;
    expect(emp.asIs).toBe(1000);
    // 10 portions at 50%: 1020 Tritanium (4) + 85 Pyerite (10) + 5 Nocxium (800)
    expect(emp.options.base).toBe(1020 * 4 + 85 * 10 + 5 * 800);
    // at 55%: 1122 + 93 + 5
    expect(emp.options.skills).toBe(1122 * 4 + 93 * 10 + 5 * 800);
    expect(emp.best).toBe("skills");

    const plex = result.items.find((row) => row.typeId === 44992)!;
    expect(plex).toMatchObject({ reprocessable: false, asIs: 5_000_000, best: "asIs", options: { base: 5_000_000, skills: 5_000_000 } });
    expect(result.totals).toEqual({
      asIs: 5_001_000,
      options: { base: 5_000_000 + emp.options.base, skills: 5_000_000 + emp.options.skills },
      mixed: { base: 5_000_000 + emp.options.base, skills: 5_000_000 + emp.options.skills },
      notReprocessable: 5_000_000,
      fees: { asIs: 0, options: { base: 0, skills: 0 } },
    });
    expect(result.materials.map((m) => [m.name, m.units.base, m.units.skills])).toEqual([
      ["Tritanium", 1020, 1122],
      ["Pyerite", 85, 93],
      ["Nocxium", 5, 5],
    ]);
  });

  it("shows what reaches the wallet, and what sales tax and the broker fee took", () => {
    const items: AppraisalItem[] = [{ typeId: 44992, name: "PLEX", quantity: 1, reprocess: null }];
    const rates = { reprocessingTax: 0, salesTax: 0.05, brokerFee: 0.02 };
    const now = appraise(appraisal(items, books), { basis: "buy", ...rates }, BASE_55);
    expect(now.totals.asIs).toBeCloseTo(4_750_000, 4);
    expect(now.totals.fees.asIs).toBeCloseTo(250_000, 4);
    const listed = appraise(appraisal(items, books), { basis: "sell", ...rates }, BASE_55);
    expect(listed.totals.asIs).toBeCloseTo(5_115_000, 4);
    expect(listed.totals.fees.asIs).toBeCloseTo(385_000, 4);
  });

  it("reprocesses only where it pays in the mixed total", () => {
    const items: AppraisalItem[] = [{ typeId: 185, name: "EMP S", quantity: 1000, reprocess: reprocessing(185) }];
    const dear = { ...books, 185: { buy: [[100, 1000]], sell: [] } } satisfies Appraisal["books"];
    const result = appraise(appraisal(items, dear), noFees(), BASE_55);
    expect(result.items[0].best).toBe("asIs");
    expect(result.totals.mixed.skills).toBe(100_000);
    expect(result.totals.options.skills).toBeLessThan(100_000);
  });

  it("flags items without a price and stacks the buy orders cannot take", () => {
    const items: AppraisalItem[] = [{ typeId: 185, name: "EMP S", quantity: 5000, reprocess: reprocessing(185) }];
    expect(appraise(appraisal(items, books), noFees(), BASE_55).items[0]).toMatchObject({ partial: true, unpriced: false });
    expect(appraise(appraisal(items, {}), noFees(), BASE_55).items[0]).toMatchObject({ unpriced: true, asIs: 0 });
  });

  it("counts units short of a portion as sold as they are", () => {
    const items: AppraisalItem[] = [{ typeId: 185, name: "EMP S", quantity: 150, reprocess: reprocessing(185) }];
    const row = appraise(appraisal(items, books), noFees(), BASE_55).items[0];
    expect(row.leftover).toBe(50);
    expect(row.options.base).toBe(102 * 4 + 8 * 10 + 0 + 50 * 1);
  });
});

describe("booksFrom", () => {
  it("sums units per price at the hub only, best price first on each side", () => {
    const books = booksFrom(
      [order(34, 4, 100, true), order(34, 4.5, 50, true), order(34, 4.5, 25, true), order(34, 6, 10, false), order(34, 5, 10, false), order(34, 9, 1, true, 123)],
      JITA,
    );
    expect(books.get(34)).toEqual({ buy: [[4.5, 75], [4, 100]], sell: [[5, 10], [6, 10]] });
  });
});

describe("hubPrices at Jita", () => {
  it("reads each type from the regional market once, then serves it from the cache while fresh", async () => {
    const userId = await profile(1, []);
    esiPages.mockImplementation(async (path: string) => {
      const typeId = Number(/type_id=(\d+)/.exec(path)![1]);
      return [order(typeId, 4, 100, true), order(typeId, 5, 100, false)];
    });
    const first = await hubPrices("jita", [34, 35], userId);
    expect(esiPages).toHaveBeenCalledTimes(2);
    expect(esiPages.mock.calls[0][0]).toBe("/markets/10000002/orders?order_type=all&type_id=34");
    expect(first.books.get(34)).toEqual({ buy: [[4, 100]], sell: [[5, 100]] });
    expect(first.available).toBe(true);

    await hubPrices("jita", [34, 35], userId);
    expect(esiPages).toHaveBeenCalledTimes(2);

    await db.execute(sql`UPDATE market_prices SET fetched_at = ${new Date(Date.now() - PRICE_MAX_AGE_MS - 1000)}`);
    await hubPrices("jita", [34], userId);
    expect(esiPages).toHaveBeenCalledTimes(3);
  });

  it("caches a type with no orders as an empty book, and keeps older prices when ESI fails", async () => {
    const userId = await profile(1, []);
    esiPages.mockResolvedValueOnce([]);
    expect((await hubPrices("jita", [34], userId)).books.get(34)).toEqual({ buy: [], sell: [] });

    await db.insert(marketPrices).values({ locationId: JITA, typeId: 35, buy: [[9, 1]], sell: [], fetchedAt: new Date(0) });
    esiPages.mockRejectedValue(new EsiError("down", 503));
    const prices = await hubPrices("jita", [35, 36], userId);
    expect(prices.books.get(35)).toEqual({ buy: [[9, 1]], sell: [] });
    expect(prices.books.has(36)).toBe(false);
    expect(prices.warnings[0]).toMatch(/did not answer for 2 items; 1 of them use older prices; 1 have no price/);
  });
});

describe("hubPrices at 4-HWWF", () => {
  it("has no prices until a character that allows market reading exists", async () => {
    const userId = await profile(1, []);
    const prices = await hubPrices("4-hwwf", [34], userId);
    expect(prices).toMatchObject({ available: false, asOf: null });
    expect(prices.warnings[0]).toMatch(/No 4-HWWF prices yet: no character allows market reading/);
    expect(esiPages).not.toHaveBeenCalled();

    // Within the lease the failure is repeated, not mistaken for a read in progress.
    const again = await hubPrices("4-hwwf", [34], userId);
    expect(again.warnings[0]).toMatch(/no character allows market reading.*tried again at most every two minutes/);
  });

  it("reads the whole structure market with a reader's token, and caches it for everyone", async () => {
    const reader = await profile(1);
    const other = await profile(2, []);
    esiPages.mockResolvedValue([order(34, 6, 500, true, HWWF), order(34, 7, 100, false, HWWF), order(35, 15, 10, false, HWWF)]);

    const prices = await hubPrices("4-hwwf", [34, 35, 36], other);
    expect(characterAccessToken).toHaveBeenCalledWith(reader, 1, "markets", expect.any(AbortSignal));
    expect(esiPages).toHaveBeenCalledWith(`/markets/structures/${HWWF}`, { token: "token", maxPages: 200, signal: expect.any(AbortSignal) });
    expect(prices.available).toBe(true);
    expect(prices.books.get(34)).toEqual({ buy: [[6, 500]], sell: [[7, 100]] });
    // Read whole, so a type missing from it has no orders there.
    expect(prices.books.get(36)).toEqual({ buy: [], sell: [] });
    expect(await structureMarketStatus("4-hwwf", other)).toMatchObject({ readers: 1, ownReaders: 0, error: null });

    await hubPrices("4-hwwf", [34], reader);
    expect(esiPages).toHaveBeenCalledTimes(1);
  });

  it("tries the next reader when one cannot dock there, and remembers who worked", async () => {
    const viewer = await profile(1);
    await profile(2);
    esiPages.mockImplementation(async () => {
      if (esiPages.mock.calls.length === 1) throw new EsiError("Forbidden", 403);
      return [order(34, 6, 500, true, HWWF)];
    });
    const prices = await hubPrices("4-hwwf", [34], viewer);
    // The viewer's own character is tried first.
    expect(characterAccessToken.mock.calls.map((call) => call[1])).toEqual([1, 2]);
    expect(prices.books.get(34)).toEqual({ buy: [[6, 500]], sell: [] });
    const [snapshot] = await db.select().from(marketSnapshots);
    expect(snapshot).toMatchObject({ readerCharacterId: 2, orders: 1, error: null });
  });

  it("keeps the last read's prices, with a warning, when no reader can read it now", async () => {
    const viewer = await profile(1);
    await db.insert(marketSnapshots).values({ locationId: HWWF, fetchedAt: new Date(0), attemptedAt: new Date(0) });
    await db.insert(marketPrices).values({ locationId: HWWF, typeId: 34, buy: [[6, 1]], sell: [], fetchedAt: new Date(0) });
    characterAccessToken.mockRejectedValue(new ConsentMissingError(1, "markets"));
    const prices = await hubPrices("4-hwwf", [34], viewer);
    expect(prices.books.get(34)).toEqual({ buy: [[6, 1]], sell: [] });
    expect(prices.warnings[0]).toMatch(/Could not read 4-HWWF's market now \(Pilot 1 no longer allows market reading\)/);

    // A failed read holds off the next one for a while, instead of retrying on every request.
    characterAccessToken.mockClear();
    await hubPrices("4-hwwf", [34], viewer);
    expect(characterAccessToken).not.toHaveBeenCalled();
  });
});

describe("appraiseItems", () => {
  it("merges repeated items, reports unknown lines, and sends only the order book the page can use", async () => {
    const userId = await profile(1, []);
    esiPages.mockImplementation(async (path: string) => {
      const typeId = Number(/type_id=(\d+)/.exec(path)![1]);
      return [order(typeId, 3, 1_000_000, true), order(typeId, 2, 1_000_000, true), order(typeId, 4, 10, false), order(typeId, 5, 10, false)];
    });
    const result = await appraiseItems(userId, "EMP S x600\nNot an item\n400 EMP S\nPLEX\t1\nVeldspar 100", "jita");
    expect(result.items.map((item) => [item.name, item.quantity, item.reprocess?.portionSize ?? null])).toEqual([
      ["EMP S", 1000, 100],
      ["PLEX", 1, null],
      ["Veldspar", 100, 100],
    ]);
    expect(result.oreSkillNames).toEqual({ [SIMPLE_ORE]: "Simple Ore Processing" });
    expect(result.unknown).toEqual(["Not an item"]);
    expect(result.materialNames).toEqual({ 34: "Tritanium", 35: "Pyerite", 38: "Nocxium" });
    expect(result.books[185]).toEqual({ buy: [[3, 1_000_000]], sell: [[4, 10]] });
    expect(result.pricesAvailable).toBe(true);
  });

  it("refuses a list with nothing it knows", async () => {
    const userId = await profile(1, []);
    await expect(appraiseItems(userId, "hello\nworld", "jita")).rejects.toThrow(AppraisalError);
    await expect(appraiseItems(userId, "   ", "jita")).rejects.toThrow("Paste at least one item.");
  });
});

describe("characterRates", () => {
  it("reads a character's skills and standings, keeping only what the calculator uses", async () => {
    const userId = await profile(1, [...FEATURE_SCOPES.skills]);
    esi.mockImplementation(async (path: string) =>
      path.endsWith("/skills")
        ? {
            skills: [
              { skill_id: SKILL.scrapmetal, active_skill_level: 5 },
              { skill_id: SKILL.accounting, active_skill_level: 3 },
              { skill_id: SIMPLE_ORE, active_skill_level: 4 },
              { skill_id: 3300, active_skill_level: 5 }, // Gunnery: not ours to keep
              { skill_id: SKILL.brokerRelations, active_skill_level: 0 },
            ],
          }
        : [
            { from_id: HUBS.jita.owner.id, from_type: "npc_corp", standing: 1.5 },
            { from_id: HUBS.jita.faction.id, from_type: "faction", standing: -0.5 },
            { from_id: 1000125, from_type: "npc_corp", standing: 9 },
            { from_id: 3008416, from_type: "agent", standing: 4 },
          ],
    );
    const data = await characterRates(userId, 1, "Pilot 1");
    expect(characterAccessToken).toHaveBeenCalledWith(userId, 1, "skills");
    expect(esi.mock.calls.map((call) => call[0])).toEqual(["/characters/1/skills", "/characters/1/standings"]);
    expect(data).toEqual({
      id: 1,
      name: "Pilot 1",
      skills: { [SKILL.scrapmetal]: 5, [SKILL.accounting]: 3, [SIMPLE_ORE]: 4 },
      standings: { [HUBS.jita.owner.id]: 1.5, [HUBS.jita.faction.id]: -0.5 },
    });
  });
});

describe("appraisal input budget", () => {
  it("rejects too many lines before type resolution or market reads", async () => {
    vi.mocked(typesByName).mockClear();
    await expect(appraiseItems("unused", Array.from({ length: MAX_INPUT_LINES + 1 }, (_, i) => `Unknown ${i}`).join("\n"), "jita"))
      .rejects.toThrow(/item lines/);
    expect(typesByName).not.toHaveBeenCalled();
    expect(esiPages).not.toHaveBeenCalled();
  });
});

it("keeps the complete structure snapshot when ESI reports more pages than the cap", async () => {
  const viewer = await profile(1);
  await db.insert(marketSnapshots).values({ locationId: HWWF, fetchedAt: new Date(0), attemptedAt: new Date(0) });
  await db.insert(marketPrices).values({ locationId: HWWF, typeId: 34, buy: [[6, 1]], sell: [], fetchedAt: new Date(0) });
  const actual = await vi.importActual<typeof import("@/lib/eve/esi")>("@/lib/eve/esi");
  esiPages.mockImplementationOnce(actual.esiPages);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([order(34, 99, 1, true, HWWF)]), { headers: { "X-Pages": "201" } })));
  try {
    const prices = await hubPrices("4-hwwf", [34], viewer);
    expect(prices.books.get(34)).toEqual({ buy: [[6, 1]], sell: [] });
    expect(prices.warnings[0]).toMatch(/incomplete/);
    expect((await db.select().from(marketSnapshots))[0].fetchedAt).toEqual(new Date(0));
  } finally {
    vi.unstubAllGlobals();
  }
});
