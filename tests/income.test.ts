import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { characters, walletEntries, walletSyncs } from "@/db/schema";
import { completeSignIn, unlinkCharacter } from "@/lib/auth/accounts";
import { ConsentMissingError } from "@/lib/auth/tokens";
import { EsiError } from "@/lib/eve/esi";
import { featuresWith, FEATURE_SCOPES } from "@/lib/eve/sso";
import { bucketOf, bucketsBetween, buildReport, incomeReport, parseFilters, topSystems, trackedCharacters } from "@/lib/income/report";
import { deleteIncomeHistory, type JournalEntry, syncCharacterIncome, syncStaleIncome, walletRows } from "@/lib/income/sync";

const characterAccessToken = vi.hoisted(() => vi.fn<(userId: string, characterId: number, feature: string) => Promise<string>>(async () => "token"));
vi.mock("@/lib/auth/tokens", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/tokens")>()),
  characterAccessToken,
}));
const esiPages = vi.hoisted(() => vi.fn());
vi.mock("@/lib/eve/esi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/eve/esi")>()),
  esiPages,
  affiliations: vi.fn(async () => []),
}));
vi.mock("@/lib/eve/sso", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/eve/sso")>()),
  revokeRefreshToken: vi.fn(async () => undefined),
}));

const WALLET = [...FEATURE_SCOPES.wallet];
const FITTINGS = [...FEATURE_SCOPES.fittings];

async function profile(characterId: number, alts: number[] = []): Promise<string> {
  const verified = (id: number) => ({ characterId: id, name: `Pilot ${id}`, ownerHash: `h${id}`, scopes: WALLET, expiresAt: new Date() });
  const tokens = { access_token: "a", refresh_token: "r", expires_in: 1199 };
  const sign = (id: number, intent: "login" | "link", currentUserId: string | null) =>
    completeSignIn({ intent, currentUserId, verified: verified(id), tokens, affiliation: null });
  const { userId } = await sign(characterId, "login", null);
  for (const alt of alts) await sign(alt, "link", userId);
  return userId;
}

const journal = (entries: Partial<JournalEntry>[]): JournalEntry[] =>
  entries.map((entry, i) => ({ id: 1000 + i, date: "2026-10-10T12:00:00Z", ref_type: "bounty_prizes", amount: 1_000_000, ...entry }));

beforeEach(async () => {
  await db.execute(sql`TRUNCATE users, characters, sessions, wallet_entries, wallet_syncs CASCADE`);
  esiPages.mockReset();
  characterAccessToken.mockClear();
});

describe("consent", () => {
  it("re-requests features a character already granted, so a new token never drops them", () => {
    expect(featuresWith(FITTINGS, "wallet")).toEqual(["fittings", "wallet"]);
    expect(featuresWith([], "wallet")).toEqual(["wallet"]);
    expect(featuresWith([...WALLET, ...FITTINGS], "fittings")).toEqual(["fittings", "wallet"]);
  });
});

describe("walletRows", () => {
  it("keeps only income and the charges on it, with tax and the system bounties were earned in", () => {
    const rows = walletRows(
      1,
      journal([
        { id: 1, ref_type: "bounty_prizes", amount: 900, tax: 100, context_id: 30000142, context_id_type: "system_id" },
        { id: 2, ref_type: "ess_escrow_transfer", amount: 5000 },
        { id: 3, ref_type: "market_transaction", amount: -2_000_000_000 }, // a purchase
        { id: 4, ref_type: "market_transaction", amount: 75_000_000, context_id: 99, context_id_type: "market_transaction_id" },
        { id: 5, ref_type: "player_donation", amount: 50 }, // ISK moved, not earned
        { id: 6, ref_type: "agent_mission_reward", amount: 400_000, tax: 40_000 },
        { id: 7, ref_type: "brokers_fee", amount: -1000 },
        { id: 8, ref_type: "brokers_fee", amount: 300 }, // a refund is not a charge
        { id: 9, ref_type: "skill_purchase", amount: -5_000_000 }, // spending, but not on income
      ]),
    );
    expect(rows).toEqual([
      expect.objectContaining({ journalId: 1, refType: "bounty_prizes", amount: 900, tax: 100, solarSystemId: 30000142 }),
      expect.objectContaining({ journalId: 2, refType: "ess_escrow_transfer", amount: 5000, tax: 0, solarSystemId: null }),
      expect.objectContaining({ journalId: 4, refType: "market_transaction", amount: 75_000_000, solarSystemId: null }),
      expect.objectContaining({ journalId: 6, refType: "agent_mission_reward", amount: 400_000, tax: 40_000 }),
      expect.objectContaining({ journalId: 7, refType: "brokers_fee", amount: -1000 }),
    ]);
  });
});

describe("buckets", () => {
  it("starts weeks on Monday and months on the 1st", () => {
    expect(bucketOf("2026-10-18", "week")).toBe("2026-10-12"); // a Sunday
    expect(bucketOf("2026-10-12", "week")).toBe("2026-10-12");
    expect(bucketOf("2026-10-18", "month")).toBe("2026-10-01");
    expect(bucketsBetween("2026-09-28", "2026-10-18", "week")).toEqual(["2026-09-28", "2026-10-05", "2026-10-12"]);
    expect(bucketsBetween("2026-08-30", "2026-10-02", "month")).toEqual(["2026-08-01", "2026-09-01", "2026-10-01"]);
  });
});

describe("buildReport", () => {
  const rows = [
    { day: "2026-10-12", characterId: 1, refType: "bounty_prizes", amount: 100, tax: 10, hours: 2 },
    { day: "2026-10-12", characterId: 2, refType: "bounty_prizes", amount: 50, tax: 5, hours: 1 },
    { day: "2026-10-13", characterId: 1, refType: "ess_escrow_transfer", amount: 300, tax: 0, hours: 1 },
    { day: "2026-10-18", characterId: 2, refType: "bounty_prizes", amount: 20, tax: 2, hours: 1 },
    { day: "2026-10-18", characterId: 2, refType: "market_transaction", amount: 1000, tax: 0, hours: 1 },
    { day: "2026-10-18", characterId: 2, refType: "brokers_fee", amount: -30, tax: 0, hours: 1 },
    { day: "2026-10-18", characterId: 2, refType: "transaction_tax", amount: -40, tax: 0, hours: 1 },
  ];

  it("fills every day in range and splits each by character and source", () => {
    const report = buildReport(rows, "2026-10-12", "2026-10-18", "day");
    expect(report.buckets.map((b) => b.key)).toHaveLength(7);
    expect(report.buckets[0]).toMatchObject({ total: 150, byCharacter: { 1: 100, 2: 50 }, bySource: { bounties: 150, ess: 0, market: 0 } });
    expect(report.buckets[3].total).toBe(0);
    expect(report.buckets[6].bySource).toMatchObject({ bounties: 20, market: 1000 });
    expect(report.totals).toMatchObject({
      amount: 1470,
      tax: 17,
      taxedGross: 187,
      activeDays: 3,
      bountyHours: 4,
      bestDay: { day: "2026-10-18", amount: 1020 },
    });
  });

  it("rolls days up into weeks and ranks characters by income", () => {
    const report = buildReport(rows, "2026-10-12", "2026-10-18", "week");
    expect(report.buckets).toEqual([expect.objectContaining({ key: "2026-10-12", total: 1470 })]);
    expect(report.characters.map((c) => c.characterId)).toEqual([2, 1]);
    expect(report.characters[0]).toMatchObject({ amount: 1070, activeDays: 2, bountyHours: 2, lastDay: "2026-10-18", bestDay: { day: "2026-10-18", amount: 1020 } });
  });

  it("leaves charges out unless asked, and then counts income before corporation tax", () => {
    expect(buildReport(rows, "2026-10-12", "2026-10-18", "day").totals).toMatchObject({ amount: 1470, expenses: 0, byCharge: {} });

    const report = buildReport(rows, "2026-10-12", "2026-10-18", "day", true);
    // Income before tax, less tax and fees, is still what the wallets kept.
    expect(report.totals).toMatchObject({
      amount: 1487,
      expenses: 87,
      byExpense: { taxes: 57, fees: 30 },
      byCharge: { "Corporation tax": 17, "Broker fees": 30, "Sales tax": 40 },
    });
    expect(report.totals.amount - report.totals.expenses).toBe(1400);
    expect(report.buckets[0]).toMatchObject({ total: 165, expenses: 15, expensesByCharacter: { 1: 10, 2: 5 } });
    expect(report.buckets[6]).toMatchObject({ total: 1022, expenses: 72, byExpense: { taxes: 42, fees: 30 } });
    expect(report.characters[0]).toMatchObject({ characterId: 2, amount: 1077, expenses: 77 });
  });
});

describe("parseFilters", () => {
  it("defaults, picks a grouping that suits the range, and ignores junk", () => {
    expect(parseFilters({})).toEqual({ range: "30d", grouping: "day", characterIds: [], sources: [], stack: "character", expenses: false });
    expect(parseFilters({ range: "1y" }).grouping).toBe("week");
    expect(parseFilters({ range: "1y", group: "month", c: ["5", "x", "5", "-1"], s: ["market", "ess", "loot"], stack: "source", exp: "1" })).toEqual({
      range: "1y",
      grouping: "month",
      characterIds: [5],
      sources: ["ess", "market"],
      stack: "source",
      expenses: true,
    });
    expect(parseFilters({ range: "forever", group: "hour", s: "loot" })).toMatchObject({ range: "30d", grouping: "day", sources: [] });
    // Every source picked is the unfiltered view.
    expect(parseFilters({ s: ["bounties", "ess", "missions", "market", "contracts", "rewards"] }).sources).toEqual([]);
  });
});

describe("sync and report", () => {
  it("stores income lines once however often the same journal is read", async () => {
    const userId = await profile(1);
    esiPages.mockResolvedValue(journal([{ id: 1 }, { id: 2, ref_type: "ess_escrow_transfer" }, { id: 3, ref_type: "player_donation" }]));
    await syncCharacterIncome(userId, 1);
    await syncCharacterIncome(userId, 1);
    expect(esiPages).toHaveBeenCalledWith("/characters/1/wallet/journal", { token: "token" });
    expect(await db.$count(walletEntries)).toBe(2);
    const [state] = await db.select().from(walletSyncs);
    expect(state).toMatchObject({ characterId: 1, error: null });
    expect(state.historyFrom!.getTime()).toBeLessThan(Date.now() - 29 * 24 * 60 * 60 * 1000);
  });

  it("records a failed sync and keeps the data it already had", async () => {
    const userId = await profile(1);
    esiPages.mockResolvedValueOnce(journal([{ id: 1 }]));
    await syncCharacterIncome(userId, 1);
    esiPages.mockRejectedValueOnce(new EsiError("ESI down", 503));
    await syncCharacterIncome(userId, 1);
    characterAccessToken.mockRejectedValueOnce(new ConsentMissingError(1, "wallet"));
    await syncCharacterIncome(userId, 1);
    const [state] = await db.select().from(walletSyncs);
    expect(state.error).toMatch(/revoked/);
    expect(state.syncedAt).not.toBeNull();
    expect(await db.$count(walletEntries)).toBe(1);
  });

  it("syncs only tracking characters that are due", async () => {
    const userId = await profile(1, [2]);
    await db.update(characters).set({ scopes: FITTINGS }).where(eq(characters.id, 2));
    esiPages.mockResolvedValue([]);
    await syncStaleIncome(userId);
    await syncStaleIncome(userId);
    expect(characterAccessToken.mock.calls.map(([, id]) => id)).toEqual([1]);
  });

  it("reports only the profile's own characters, with filters applied", async () => {
    const mine = await profile(1, [2]);
    const theirs = await profile(3);
    const now = new Date("2026-10-18T20:00:00Z");
    esiPages.mockResolvedValueOnce(
      journal([
        { id: 1, date: "2026-10-17T10:00:00Z", amount: 100, context_id: 30000142, context_id_type: "system_id" },
        { id: 2, date: "2026-10-17T10:20:00Z", amount: 100, context_id: 30000142, context_id_type: "system_id" },
        { id: 3, date: "2026-10-18T09:00:00Z", ref_type: "ess_escrow_transfer", amount: 500 },
        { id: 4, date: "2026-08-01T09:00:00Z", amount: 999 }, // outside 30 days
        { id: 7, date: "2026-10-16T09:00:00Z", ref_type: "market_transaction", amount: 3000 },
        { id: 8, date: "2026-10-16T08:00:00Z", ref_type: "brokers_fee", amount: -60, context_id: 30000142, context_id_type: "system_id" },
      ]),
    );
    await syncCharacterIncome(mine, 1);
    esiPages.mockResolvedValueOnce(journal([{ id: 5, date: "2026-10-18T10:00:00Z", amount: 40, context_id: 30002187, context_id_type: "system_id" }]));
    await syncCharacterIncome(mine, 2);
    esiPages.mockResolvedValueOnce(journal([{ id: 6, date: "2026-10-18T10:00:00Z", amount: 7777 }]));
    await syncCharacterIncome(theirs, 3);

    const all = await incomeReport(mine, parseFilters({}), now);
    expect(all.totals).toMatchObject({ amount: 3740, bountyHours: 2, activeDays: 3 });
    expect(all.characters.map((c) => [c.characterId, c.amount])).toEqual([
      [1, 3700],
      [2, 40],
    ]);

    const essOnly = await incomeReport(mine, parseFilters({ s: "ess" }), now);
    expect(essOnly.totals.amount).toBe(500);
    const ratting = await incomeReport(mine, parseFilters({ s: ["bounties", "ess"] }), now);
    expect(ratting.totals.amount).toBe(740);
    // Charges follow the income they are charged on.
    const withExpenses = await incomeReport(mine, parseFilters({ exp: "1" }), now);
    expect(withExpenses.totals).toMatchObject({ amount: 3740, expenses: 60, byCharge: { "Broker fees": 60 } });
    expect((await incomeReport(mine, parseFilters({ exp: "1", s: "bounties" }), now)).totals.expenses).toBe(0);
    // Asking for someone else's character yields nothing of theirs.
    const pried = await incomeReport(mine, parseFilters({ c: "3" }), now);
    expect(pried.totals.amount).toBe(0);

    const everything = await incomeReport(mine, parseFilters({ range: "all" }), now);
    expect(everything.from).toBe("2026-08-01");
    expect(everything.totals.amount).toBe(4739);

    expect(await topSystems(mine, parseFilters({}), all.from)).toEqual([
      { solarSystemId: 30000142, amount: 200, characters: 1 },
      { solarSystemId: 30002187, amount: 40, characters: 1 },
    ]);
    expect(await topSystems(mine, parseFilters({ s: "market" }), all.from)).toEqual([]);
    expect((await trackedCharacters(mine)).map((c) => [c.id, c.tracking, c.entries])).toEqual([
      [1, true, 6],
      [2, true, 1],
    ]);
  });

  it("deletes history on request, and with the character when it is unlinked", async () => {
    const userId = await profile(1, [2]);
    const other = await profile(3);
    esiPages.mockResolvedValue(journal([{ id: 1 }]));
    await syncCharacterIncome(userId, 1);
    await syncCharacterIncome(userId, 2);

    await expect(deleteIncomeHistory(other, 1)).rejects.toThrow(/not linked/);
    await deleteIncomeHistory(userId, 1);
    expect(await db.select({ id: walletEntries.characterId }).from(walletEntries)).toEqual([{ id: 2 }]);

    await unlinkCharacter(userId, 2);
    expect(await db.$count(walletEntries)).toBe(0);
    expect(await db.$count(walletSyncs)).toBe(0);
  });
});
