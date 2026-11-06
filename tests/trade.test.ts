import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { eveTypes, walletEntries, walletTransactions } from "@/db/schema";
import { completeSignIn } from "@/lib/auth/accounts";
import { FEATURE_SCOPES } from "@/lib/eve/sso";
import { type EsiTransaction, type JournalEntry, syncCharacterIncome } from "@/lib/income/sync";
import { holdings, matchTrades, type Trade } from "@/lib/trade/fifo";
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
    expect(lots).toEqual([expect.objectContaining({ characterId: 2, quantity: 5, unitPrice: 7 })]);
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
    expect(holdings(lots)).toEqual([{ typeId: 34, quantity: 3, cost: 50, oldest: at("2026-10-01"), newest: at("2026-10-05") }]);
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
    await db.execute(sql`TRUNCATE users, characters, sessions, wallet_entries, wallet_syncs, wallet_transactions, eve_types, trade_exclusions CASCADE`);
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
