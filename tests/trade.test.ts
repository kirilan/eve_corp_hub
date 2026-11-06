import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { characterBlueprints, characters, eveTypes, industryJobs, walletEntries, walletSyncs, walletTransactions } from "@/db/schema";
import { completeSignIn } from "@/lib/auth/accounts";
import { FEATURE_SCOPES } from "@/lib/eve/sso";
import { type EsiJob, type EsiTransaction, type JournalEntry, syncCharacterIncome } from "@/lib/income/sync";
import { type BlueprintSeen, holdings, type Job, matchTrades, type Trade } from "@/lib/trade/fifo";
import { requiredQuantity } from "@/lib/trade/recipes";
import { bucketEnd, setTradeExclusion, summarise, tradeReport } from "@/lib/trade/report";

vi.mock("@/lib/auth/tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/tokens")>()),
  characterAccessToken: vi.fn(async () => "token"),
}));
const esiPages = vi.hoisted(() => vi.fn());
const esi = vi.hoisted(() => vi.fn<(path: string) => Promise<unknown>>(async () => []));
vi.mock("@/lib/eve/esi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/eve/esi")>()),
  esiPages,
  esi,
  affiliations: vi.fn(async () => []),
}));
vi.mock("@/lib/eve/categories", () => ({ categoryNames: vi.fn(async (ids: number[]) => Object.fromEntries(ids.map((id) => [id, `Cat ${id}`]))) }));
vi.mock("@/lib/eve/prices", () => ({ averagePrices: vi.fn(async () => ({ 34: 6 })) }));

const at = (day: string, time = "12:00:00") => new Date(`${day}T${time}Z`);
let nextId = 1;
const trade = (t: Partial<Trade> & Pick<Trade, "isBuy" | "quantity" | "unitPrice">): Trade => ({
  characterId: 1,
  transactionId: nextId++,
  date: at("2026-10-10"),
  typeId: 34,
  tax: 0,
  ...t,
});

describe("matchTrades", () => {
  it("matches sales to the oldest purchases across characters, first in first out", () => {
    const { sales, lots } = matchTrades([
      trade({ isBuy: true, quantity: 10, unitPrice: 5, date: at("2026-10-01"), characterId: 1 }),
      trade({ isBuy: true, quantity: 10, unitPrice: 7, date: at("2026-10-02"), characterId: 2 }),
      // Sold on another character than the one that bought: still the same stock.
      trade({ isBuy: false, quantity: 15, unitPrice: 10, date: at("2026-10-03"), characterId: 3, tax: 6 }),
    ]);
    expect(sales).toHaveLength(1);
    // 10 at 5 and 5 at 7 = 85; tax on the matched 15 of 15 units.
    expect(sales[0]).toMatchObject({ quantity: 15, matched: 15, revenue: 150, cost: 85, profit: 150 - 85 - 6 });
    expect(lots).toEqual([expect.objectContaining({ characterId: 2, quantity: 5, unitCost: 7, built: false })]);
  });

  it("keeps units with no purchase on record out of profit", () => {
    const { sales } = matchTrades([
      trade({ isBuy: true, quantity: 2, unitPrice: 100 }),
      trade({ isBuy: false, quantity: 5, unitPrice: 150, tax: 50, date: at("2026-10-11") }),
    ]);
    // Two matched units: 300 - 200, less 2/5 of the tax.
    expect(sales[0]).toMatchObject({ matched: 2, matchedRevenue: 300, cost: 200, profit: 80, revenue: 750 });
  });

  it("books a loss when an item sold below what it cost", () => {
    const { sales } = matchTrades([trade({ isBuy: true, quantity: 1, unitPrice: 1000 }), trade({ isBuy: false, quantity: 1, unitPrice: 800, date: at("2026-10-11") })]);
    expect(sales[0].profit).toBe(-200);
  });

  it("uses a purchase made in the same second as the sale", () => {
    const { sales } = matchTrades([trade({ isBuy: false, quantity: 1, unitPrice: 20 }), trade({ isBuy: true, quantity: 1, unitPrice: 15 })]);
    expect(sales[0]).toMatchObject({ matched: 1, profit: 5 });
  });

  it("sums unsold lots per item with their age", () => {
    const { lots } = matchTrades([
      trade({ isBuy: true, quantity: 3, unitPrice: 10, date: at("2026-10-01") }),
      trade({ isBuy: true, quantity: 1, unitPrice: 30, date: at("2026-10-05") }),
      trade({ isBuy: false, quantity: 1, unitPrice: 50, date: at("2026-10-06") }),
    ]);
    expect(holdings(lots)).toEqual([{ typeId: 34, quantity: 3, cost: 50, estimated: 0, built: 0, oldest: at("2026-10-01"), newest: at("2026-10-05") }]);
  });
});

describe("industry", () => {
  let jobId = 1;
  const job = (j: Partial<Job> & Pick<Job, "activityId" | "blueprintTypeId" | "runs">): Job => ({
    characterId: 1,
    jobId: jobId++,
    blueprintId: 5000 + jobId,
    productTypeId: null,
    licensedRuns: null,
    successfulRuns: null,
    cost: 0,
    status: "delivered",
    facilityId: 60003760,
    startDate: at("2026-10-02"),
    endDate: at("2026-10-03"),
    completedDate: at("2026-10-03"),
    ...j,
  });
  const original = (itemId: number, typeId: number, me = 0): BlueprintSeen => ({ itemId, typeId, me, te: 0, quantity: -1, firstSeen: at("2026-10-01") });

  it("applies material efficiency the way EVE rounds it", () => {
    expect(requiredQuantity(862, 1, 10)).toBe(776);
    expect(requiredQuantity(100, 10, 10)).toBe(900);
    // Never less than one unit per run.
    expect(requiredQuantity(1, 10, 10)).toBe(10);
  });

  it("costs a product through a two-step chain from bought and unrecorded materials", () => {
    // Blueprint 1102 builds type 526 from 862 Tritanium, 792 Pyerite and 529 Mexallon; blueprint 2741
    // builds type 17178 from one 526, one 2867 and one 2876 (SDE).
    const { sales, lots, industry } = matchTrades(
      [
        trade({ isBuy: true, typeId: 34, quantity: 862, unitPrice: 5, date: at("2026-10-01") }),
        trade({ isBuy: true, typeId: 35, quantity: 792, unitPrice: 10, date: at("2026-10-01") }),
        trade({ isBuy: true, typeId: 36, quantity: 529, unitPrice: 20, date: at("2026-10-01") }),
        trade({ isBuy: true, typeId: 2867, quantity: 1, unitPrice: 1000, date: at("2026-10-01") }),
        trade({ isBuy: false, typeId: 17178, quantity: 1, unitPrice: 30000, date: at("2026-10-06") }),
      ],
      {
        jobs: [
          job({ activityId: 1, blueprintTypeId: 1102, blueprintId: 1, runs: 1, cost: 190 }),
          job({ activityId: 1, blueprintTypeId: 2741, blueprintId: 2, runs: 1, startDate: at("2026-10-04"), completedDate: at("2026-10-05") }),
        ],
        blueprints: [original(1, 1102), original(2, 2741)],
        // 2876 was never bought: valued at its market price.
        prices: { 2876: 500 },
      },
    );
    // 4310 + 7920 + 10580 of minerals and a 190 fee make the component; 1000 and an estimated 500 the rest.
    expect(sales[0]).toMatchObject({ matched: 1, built: 1, cost: 24500, estimated: 500, profit: 5500 });
    expect(lots.filter((l) => l.quantity > 0)).toEqual([]);
    expect(industry.estimated).toEqual({ units: 1, value: 500 });
  });

  it("uses the blueprint's ME, and leaves what a job did not use in stock", () => {
    const { lots } = matchTrades([trade({ isBuy: true, typeId: 34, quantity: 1000, unitPrice: 1, date: at("2026-10-01") })], {
      jobs: [job({ activityId: 1, blueprintTypeId: 1102, blueprintId: 1, runs: 1 })],
      blueprints: [original(1, 1102, 10)],
      prices: { 35: 1, 36: 1 },
    });
    expect(lots.find((l) => l.typeId === 34)?.quantity).toBe(1000 - 776);
    expect(lots.find((l) => l.typeId === 526)).toMatchObject({ quantity: 1, built: true, unitCost: 776 + 713 + 477 });
  });

  it("carries copying and invention, failures included, onto the T2 runs that used them", () => {
    // Blueprint 683 invents 39581 (one run per success) from two of each data core per attempt.
    const materials = { 582: 1, 11550: 1, 11478: 1, 11399: 1, 11558: 1, 3828: 1, 11533: 1, 11534: 1, 11540: 1, 11552: 1, 11544: 1 };
    const { sales, industry } = matchTrades(
      [
        trade({ isBuy: true, typeId: 20416, quantity: 4, unitPrice: 1000, date: at("2026-10-01") }),
        trade({ isBuy: true, typeId: 25887, quantity: 4, unitPrice: 2000, date: at("2026-10-01") }),
        trade({ isBuy: false, typeId: 37458, quantity: 1, unitPrice: 50000, date: at("2026-10-09") }),
      ],
      {
        jobs: [
          job({ activityId: 5, blueprintTypeId: 683, runs: 2, licensedRuns: 1, cost: 100, startDate: at("2026-10-01"), completedDate: at("2026-10-02") }),
          // Two attempts, one success.
          job({ activityId: 8, blueprintTypeId: 683, productTypeId: 39581, runs: 2, successfulRuns: 1, cost: 200, startDate: at("2026-10-03"), completedDate: at("2026-10-04") }),
          job({ activityId: 1, blueprintTypeId: 39581, blueprintId: 77, runs: 1, startDate: at("2026-10-05"), completedDate: at("2026-10-06") }),
        ],
        blueprints: [{ itemId: 77, typeId: 39581, me: 2, te: 4, quantity: -2, firstSeen: at("2026-10-04") }],
        prices: materials,
      },
    );
    // 100 + 200 + 12000 for the copy run; 764 units of materials at ME 2, all valued at 1.
    expect(sales[0]).toMatchObject({ matched: 1, built: 1, cost: 12300 + 764, estimated: 764 });
    expect(industry.notes.missingCopyRuns).toBeUndefined();
  });

  it("reads the decryptor off the copies an invention made", () => {
    const { sales } = matchTrades(
      [
        trade({ isBuy: true, typeId: 34206, quantity: 1, unitPrice: 9000, date: at("2026-10-01") }),
        trade({ isBuy: false, typeId: 37458, quantity: 1, unitPrice: 50000, date: at("2026-10-09") }),
      ],
      {
        jobs: [
          job({ activityId: 8, blueprintTypeId: 683, productTypeId: 39581, runs: 1, successfulRuns: 1, startDate: at("2026-10-03"), completedDate: at("2026-10-04") }),
          job({ activityId: 1, blueprintTypeId: 39581, blueprintId: 78, runs: 1, startDate: at("2026-10-05"), completedDate: at("2026-10-06") }),
        ],
        // ME 3, TE 12: a Symmetry Decryptor (+1 ME, +8 TE, +2 runs), so the success made three runs.
        blueprints: [{ itemId: 78, typeId: 39581, me: 3, te: 12, quantity: -2, firstSeen: at("2026-10-04") }],
        prices: { 20416: 0, 25887: 0 },
      },
    );
    // A third of the decryptor's 9000 on the one run used; materials have no price and cost nothing.
    expect(sales[0].cost).toBeCloseTo(3000);
  });

  it("counts running and cancelled jobs apart", () => {
    const { industry } = matchTrades([], {
      jobs: [
        job({ activityId: 1, blueprintTypeId: 1102, runs: 1, cost: 50, status: "active", completedDate: null }),
        job({ activityId: 1, blueprintTypeId: 1102, runs: 1, cost: 70, status: "cancelled", completedDate: null }),
        job({ activityId: 4, blueprintTypeId: 1102, runs: 1, cost: 30 }),
      ],
      prices: { 34: 0 },
    });
    expect(industry.inProgress).toEqual({ jobs: 1, cost: 50 });
    expect(industry.lost).toEqual({ jobs: 1, cost: 70 });
    expect(industry.research).toEqual({ jobs: 1, cost: 30 });
  });
});

describe("summarise", () => {
  it("splits each bucket into items that made money and items that lost it, per category", () => {
    const { sales } = matchTrades([
      trade({ isBuy: true, quantity: 1, unitPrice: 100, typeId: 1, date: at("2026-10-01") }),
      trade({ isBuy: true, quantity: 1, unitPrice: 100, typeId: 2, date: at("2026-10-01") }),
      trade({ isBuy: false, quantity: 1, unitPrice: 150, typeId: 1, date: at("2026-10-05") }),
      trade({ isBuy: false, quantity: 1, unitPrice: 70, typeId: 2, date: at("2026-10-05") }),
    ]);
    const scope = { from: "2026-10-01", to: "2026-10-10", grouping: "week" as const, characterIds: [], at: null };
    const summary = summarise(sales, scope, (typeId) => (typeId === 1 ? 6 : 7));
    // 2026-10-05 is a Monday: the sales open that week.
    const week = summary.buckets.find((b) => b.key === "2026-10-05")!;
    expect(week).toEqual({ key: "2026-10-05", profit: 20, gains: { 6: 50 }, losses: { 7: 30 } });
    expect(summary.totals.profit).toBe(20);
    expect(summarise(sales, { ...scope, at: "2026-10-05" }, () => 6).totals.sold).toBe(2);
    // Looking into the week before leaves both sales out of the tables, not out of the chart.
    const before = summarise(sales, { ...scope, at: "2026-09-28" }, () => 6);
    expect([before.totals.sold, before.rangeTotals.sold]).toEqual([0, 2]);
  });

  it("knows where each bucket ends", () => {
    expect(bucketEnd("2026-10-12", "week")).toBe("2026-10-18");
    expect(bucketEnd("2026-02-01", "month")).toBe("2026-02-28");
    expect(bucketEnd("2026-10-12", "day")).toBe("2026-10-12");
  });
});

describe("sync and trade report", () => {
  async function profile(ids: number[]): Promise<string> {
    const tokens = { access_token: "a", refresh_token: "r", expires_in: 1199 };
    let userId: string | null = null;
    for (const id of ids) {
      const verified = { characterId: id, name: `Pilot ${id}`, ownerHash: `h${id}`, scopes: [...FEATURE_SCOPES.wallet], expiresAt: new Date() };
      const result = await completeSignIn({ intent: userId ? "link" : "login", currentUserId: userId, verified, tokens, affiliation: null });
      userId = result.userId;
    }
    return userId!;
  }
  const tx = (t: Partial<EsiTransaction> & Pick<EsiTransaction, "transaction_id" | "is_buy" | "quantity" | "unit_price">): EsiTransaction => ({
    date: "2026-10-10T12:00:00Z",
    type_id: 34,
    location_id: 60003760,
    client_id: 9000,
    journal_ref_id: t.transaction_id + 100,
    ...t,
  });

  beforeEach(async () => {
    await db.execute(sql`TRUNCATE users, characters, sessions, wallet_entries, wallet_syncs, wallet_transactions, eve_types, trade_exclusions, industry_jobs, character_blueprints CASCADE`);
    esiPages.mockReset();
    esi.mockReset();
    esi.mockImplementation(async () => []);
    await db.insert(eveTypes).values([
      { id: 34, name: "Tritanium", groupId: 18, categoryId: 4 },
      { id: 587, name: "Rifter", groupId: 25, categoryId: 6 },
    ]);
  });

  it("stores transactions, ties sales tax to its sale, and reports profit and unsold stock", async () => {
    const userId = await profile([1, 2]);
    const journal: JournalEntry[] = [
      { id: 1, date: "2026-10-11T12:00:00Z", ref_type: "market_transaction", amount: 1500, context_id: 3, context_id_type: "market_transaction_id" },
      { id: 2, date: "2026-10-11T12:00:00Z", ref_type: "transaction_tax", amount: -60, context_id: 3, context_id_type: "market_transaction_id" },
      { id: 3, date: "2026-10-11T12:00:00Z", ref_type: "brokers_fee", amount: -25 },
    ];
    esiPages.mockResolvedValueOnce(journal);
    esi.mockImplementation(async (path) =>
      path.startsWith("/characters/1/wallet/transactions")
        ? [
            tx({ transaction_id: 1, is_buy: true, quantity: 100, unit_price: 10, date: "2026-10-09T12:00:00Z" }),
            tx({ transaction_id: 2, is_buy: true, quantity: 1, unit_price: 500000, type_id: 587 }),
            tx({ transaction_id: 3, is_buy: false, quantity: 60, unit_price: 25, date: "2026-10-11T12:00:00Z" }),
            // Sold to an alt: not a trade.
            tx({ transaction_id: 4, is_buy: false, quantity: 10, unit_price: 99, client_id: 2, date: "2026-10-11T13:00:00Z" }),
          ]
        : [],
    );
    await syncCharacterIncome(userId, 1);
    expect(esi).toHaveBeenCalledWith("/characters/1/wallet/transactions", { token: "token", signal: expect.any(AbortSignal) });
    expect(await db.$count(walletTransactions)).toBe(4);
    expect((await db.select().from(walletEntries)).find((e) => e.refType === "transaction_tax")?.transactionId).toBe(3);

    const report = await tradeReport(userId, { from: "2026-10-01", to: "2026-10-31", grouping: "week", characterIds: [], at: null });
    // 60 Tritanium sold for 1500 cost 600, less 60 tax.
    expect(report.totals).toMatchObject({ sold: 60, revenue: 1500, cost: 600, tax: 60, profit: 840, brokerFees: 25 });
    expect(report.items).toEqual([expect.objectContaining({ typeId: 34, name: "Tritanium", categoryId: 4, profit: 840 })]);
    expect(report.categories).toEqual([expect.objectContaining({ categoryId: 4, name: "Cat 4", items: 1 })]);
    // The Rifter and 40 Tritanium wait; Tritanium is valued at EVE's average price, the Rifter has none.
    expect(report.holdings.map((h) => [h.name, h.quantity, h.cost, h.value])).toEqual([
      ["Rifter", 1, 500000, null],
      ["Tritanium", 40, 400, 240],
    ]);

    // Bought to fly, not to sell: out of trade performance.
    await setTradeExclusion(userId, 587, true);
    const after = await tradeReport(userId, { from: "2026-10-01", to: "2026-10-31", grouping: "week", characterIds: [], at: null });
    expect(after.holdings.map((h) => h.name)).toEqual(["Tritanium"]);
    expect(after.excluded).toEqual([{ typeId: 587, name: "Rifter" }]);

    // Another character's view: it sold nothing and holds nothing.
    const alt = await tradeReport(userId, { from: "2026-10-01", to: "2026-10-31", grouping: "week", characterIds: [2], at: null });
    expect(alt.totals.sold).toBe(0);
    expect(alt.holdings).toEqual([]);
  });

  it("reads industry jobs and blueprints for characters that allow it, and keeps a used-up copy", async () => {
    const userId = await profile([1]);
    await db.update(characters).set({ scopes: [...FEATURE_SCOPES.wallet, ...FEATURE_SCOPES.industry] });
    const esiJob: EsiJob = {
      job_id: 9, activity_id: 1, blueprint_id: 77, blueprint_type_id: 1102, product_type_id: 526, runs: 1, cost: 190,
      status: "active", facility_id: 60003760, start_date: "2026-10-10T00:00:00Z", end_date: "2026-10-11T00:00:00Z",
    };
    esiPages.mockImplementation(async (path: string) =>
      path.includes("/blueprints") ? [{ item_id: 77, type_id: 1102, material_efficiency: 10, time_efficiency: 20, runs: -1, quantity: -1 }] : [],
    );
    esi.mockImplementation(async (path) => (path.includes("/industry/jobs") ? [esiJob] : []));
    await syncCharacterIncome(userId, 1);
    expect(await db.select({ status: industryJobs.status, cost: industryJobs.cost }).from(industryJobs)).toEqual([{ status: "active", cost: 190 }]);

    // Delivered, and the blueprint gone from the hangar: the job updates, the blueprint stays on record.
    await db.update(walletSyncs).set({ attemptedAt: new Date(0) });
    esiPages.mockImplementation(async () => []);
    esi.mockImplementation(async (path) => (path.includes("/industry/jobs") ? [{ ...esiJob, status: "delivered", completed_date: "2026-10-11T01:00:00Z" }] : []));
    await syncCharacterIncome(userId, 1);
    expect((await db.select().from(industryJobs))[0]).toMatchObject({ status: "delivered", completedDate: new Date("2026-10-11T01:00:00Z") });
    expect((await db.select().from(characterBlueprints))[0]).toMatchObject({ itemId: 77, materialEfficiency: 10 });
    expect((await db.select().from(walletSyncs))[0].error).toBeNull();
  });

  it("keeps the wallet sync going when the industry read fails", async () => {
    const userId = await profile([1]);
    await db.update(characters).set({ scopes: [...FEATURE_SCOPES.wallet, ...FEATURE_SCOPES.industry] });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    esiPages.mockImplementation(async (path: string) => {
      if (path.includes("/blueprints")) throw new Error("ESI down");
      return [{ id: 1, date: "2026-10-10T12:00:00Z", ref_type: "bounty_prizes", amount: 5 }];
    });
    await syncCharacterIncome(userId, 1);
    expect(await db.$count(walletEntries)).toBe(1);
    expect((await db.select().from(walletSyncs))[0].error).toMatch(/Industry jobs could not be read/);
  });

  it("walks back through older transactions until it reaches ones already stored", async () => {
    const userId = await profile([1]);
    esiPages.mockResolvedValue([]);
    const page = (from: number) => Array.from({ length: 1000 }, (_, i) => tx({ transaction_id: from - i, is_buy: true, quantity: 1, unit_price: 1 }));
    esi.mockImplementation(async (path) => (path.includes("from_id") ? [] : page(5000)));
    await syncCharacterIncome(userId, 1);
    expect(esi.mock.calls.map(([path]) => path)).toEqual(["/characters/1/wallet/transactions", "/characters/1/wallet/transactions?from_id=4000"]);
    expect(await db.$count(walletTransactions)).toBe(1000);
  });
});
