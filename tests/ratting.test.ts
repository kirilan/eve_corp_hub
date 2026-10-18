import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { characters, rattingEntries, walletSyncs } from "@/db/schema";
import { completeSignIn, unlinkCharacter } from "@/lib/auth/accounts";
import { ConsentMissingError } from "@/lib/auth/tokens";
import { EsiError } from "@/lib/eve/esi";
import { featuresWith, FEATURE_SCOPES } from "@/lib/eve/sso";
import { bucketOf, bucketsBetween, buildReport, parseFilters, rattingReport, topSystems, trackedCharacters } from "@/lib/ratting/report";
import { deleteRattingHistory, type JournalEntry, rattingRows, syncCharacterRatting, syncStaleRatting } from "@/lib/ratting/sync";

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
  await db.execute(sql`TRUNCATE users, characters, sessions, ratting_entries, wallet_syncs CASCADE`);
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

describe("rattingRows", () => {
  it("keeps only bounty and ESS lines, with tax and the system bounties were earned in", () => {
    const rows = rattingRows(
      1,
      journal([
        { id: 1, ref_type: "bounty_prizes", amount: 900, tax: 100, context_id: 30000142, context_id_type: "system_id" },
        { id: 2, ref_type: "ess_escrow_transfer", amount: 5000 },
        { id: 3, ref_type: "market_transaction", amount: -2_000_000_000 },
        { id: 4, ref_type: "player_donation", amount: 50 },
      ]),
    );
    expect(rows).toEqual([
      expect.objectContaining({ journalId: 1, refType: "bounty_prizes", amount: 900, tax: 100, solarSystemId: 30000142 }),
      expect.objectContaining({ journalId: 2, refType: "ess_escrow_transfer", amount: 5000, tax: 0, solarSystemId: null }),
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
  ];

  it("fills every day in range and splits each by character and source", () => {
    const report = buildReport(rows, "2026-10-12", "2026-10-18", "day");
    expect(report.buckets.map((b) => b.key)).toHaveLength(7);
    expect(report.buckets[0]).toMatchObject({ total: 150, byCharacter: { 1: 100, 2: 50 }, bySource: { bounties: 150, ess: 0 } });
    expect(report.buckets[3].total).toBe(0);
    expect(report.totals).toMatchObject({ amount: 470, tax: 17, activeDays: 3, bountyHours: 4, bestDay: { day: "2026-10-13", amount: 300 } });
  });

  it("rolls days up into weeks and ranks characters by income", () => {
    const report = buildReport(rows, "2026-10-12", "2026-10-18", "week");
    expect(report.buckets).toEqual([expect.objectContaining({ key: "2026-10-12", total: 470 })]);
    expect(report.characters.map((c) => c.characterId)).toEqual([1, 2]);
    expect(report.characters[1]).toMatchObject({ amount: 70, activeDays: 2, bountyHours: 2, lastDay: "2026-10-18", bestDay: { day: "2026-10-12", amount: 50 } });
  });
});

describe("parseFilters", () => {
  it("defaults, picks a grouping that suits the range, and ignores junk", () => {
    expect(parseFilters({})).toEqual({ range: "30d", grouping: "day", characterIds: [], source: "all", stack: "character" });
    expect(parseFilters({ range: "1y" }).grouping).toBe("week");
    expect(parseFilters({ range: "1y", group: "month", c: ["5", "x", "5", "-1"], source: "ess", stack: "source" })).toEqual({
      range: "1y",
      grouping: "month",
      characterIds: [5],
      source: "ess",
      stack: "source",
    });
    expect(parseFilters({ range: "forever", group: "hour", source: "loot" })).toMatchObject({ range: "30d", grouping: "day", source: "all" });
  });
});

describe("sync and report", () => {
  it("stores ratting lines once however often the same journal is read", async () => {
    const userId = await profile(1);
    esiPages.mockResolvedValue(journal([{ id: 1 }, { id: 2, ref_type: "ess_escrow_transfer" }, { id: 3, ref_type: "market_transaction" }]));
    await syncCharacterRatting(userId, 1);
    await syncCharacterRatting(userId, 1);
    expect(esiPages).toHaveBeenCalledWith("/characters/1/wallet/journal", { token: "token" });
    expect(await db.$count(rattingEntries)).toBe(2);
    const [state] = await db.select().from(walletSyncs);
    expect(state).toMatchObject({ characterId: 1, error: null });
    expect(state.historyFrom!.getTime()).toBeLessThan(Date.now() - 29 * 24 * 60 * 60 * 1000);
  });

  it("records a failed sync and keeps the data it already had", async () => {
    const userId = await profile(1);
    esiPages.mockResolvedValueOnce(journal([{ id: 1 }]));
    await syncCharacterRatting(userId, 1);
    esiPages.mockRejectedValueOnce(new EsiError("ESI down", 503));
    await syncCharacterRatting(userId, 1);
    characterAccessToken.mockRejectedValueOnce(new ConsentMissingError(1, "wallet"));
    await syncCharacterRatting(userId, 1);
    const [state] = await db.select().from(walletSyncs);
    expect(state.error).toMatch(/revoked/);
    expect(state.syncedAt).not.toBeNull();
    expect(await db.$count(rattingEntries)).toBe(1);
  });

  it("syncs only tracking characters that are due", async () => {
    const userId = await profile(1, [2]);
    await db.update(characters).set({ scopes: FITTINGS }).where(eq(characters.id, 2));
    esiPages.mockResolvedValue([]);
    await syncStaleRatting(userId);
    await syncStaleRatting(userId);
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
      ]),
    );
    await syncCharacterRatting(mine, 1);
    esiPages.mockResolvedValueOnce(journal([{ id: 5, date: "2026-10-18T10:00:00Z", amount: 40, context_id: 30002187, context_id_type: "system_id" }]));
    await syncCharacterRatting(mine, 2);
    esiPages.mockResolvedValueOnce(journal([{ id: 6, date: "2026-10-18T10:00:00Z", amount: 7777 }]));
    await syncCharacterRatting(theirs, 3);

    const all = await rattingReport(mine, parseFilters({}), now);
    expect(all.totals).toMatchObject({ amount: 740, bountyHours: 2, activeDays: 2 });
    expect(all.characters.map((c) => [c.characterId, c.amount])).toEqual([
      [1, 700],
      [2, 40],
    ]);

    const essOnly = await rattingReport(mine, parseFilters({ source: "ess" }), now);
    expect(essOnly.totals.amount).toBe(500);
    // Asking for someone else's character yields nothing of theirs.
    const pried = await rattingReport(mine, parseFilters({ c: "3" }), now);
    expect(pried.totals.amount).toBe(0);

    const everything = await rattingReport(mine, parseFilters({ range: "all" }), now);
    expect(everything.from).toBe("2026-08-01");
    expect(everything.totals.amount).toBe(1739);

    expect(await topSystems(mine, parseFilters({}), all.from)).toEqual([
      { solarSystemId: 30000142, amount: 200, characters: 1 },
      { solarSystemId: 30002187, amount: 40, characters: 1 },
    ]);
    expect((await trackedCharacters(mine)).map((c) => [c.id, c.tracking, c.entries])).toEqual([
      [1, true, 4],
      [2, true, 1],
    ]);
  });

  it("deletes history on request, and with the character when it is unlinked", async () => {
    const userId = await profile(1, [2]);
    const other = await profile(3);
    esiPages.mockResolvedValue(journal([{ id: 1 }]));
    await syncCharacterRatting(userId, 1);
    await syncCharacterRatting(userId, 2);

    await expect(deleteRattingHistory(other, 1)).rejects.toThrow(/not linked/);
    await deleteRattingHistory(userId, 1);
    expect(await db.select({ id: rattingEntries.characterId }).from(rattingEntries)).toEqual([{ id: 2 }]);

    await unlinkCharacter(userId, 2);
    expect(await db.$count(rattingEntries)).toBe(0);
    expect(await db.$count(walletSyncs)).toBe(0);
  });
});
