import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { fittings, pvpCrawls, pvpFits, pvpPilots } from "@/db/schema";
import { completeSignIn, loadViewer, type Viewer } from "@/lib/auth/accounts";
import type { TypeInfo } from "@/lib/fittings/eft";
import { crawlPvpFits, pvpFitName } from "@/lib/pvp/crawl";
import { copyTopPvpFit, pvpWeeks, sendTopPvpFit, topPvpFit, topPvpPilots } from "@/lib/pvp/fits";
import { fitFromLoss, loadoutKey, parseRanks, type ZkillKillmail } from "@/lib/pvp/killmail";
import { weeklyLosses, weeklyRanksPage } from "@/lib/pvp/zkill";
import { BY_ID } from "./fixtures/types";

const TYPES = new Map<number, TypeInfo>([...BY_ID, [670, { id: 670, name: "Capsule", groupId: 29, categoryId: 6, slot: null }]]);

vi.mock("next/cache", () => ({ cacheLife: () => {}, cacheTag: () => {} }));
vi.mock("@/lib/eve/types", () => ({
  typesById: vi.fn(async (ids: number[]) => new Map(ids.flatMap((id) => (TYPES.has(id) ? [[id, TYPES.get(id)!]] : [])))),
}));
vi.mock("@/lib/pvp/zkill", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pvp/zkill")>()),
  weeklyRanksPage: vi.fn(),
  weeklyLosses: vi.fn(),
}));
vi.mock("@/lib/auth/tokens", () => ({ characterAccessToken: vi.fn(async () => "token") }));
const esi = vi.hoisted(() => vi.fn());
vi.mock("@/lib/eve/esi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/eve/esi")>()),
  esi,
  affiliations: vi.fn(async () => []),
  names: vi.fn(async (ids: number[]) => ids.map((id) => ({ id, name: `Pilot ${id}`, category: "character" }))),
}));

// The shape of a row on zKillboard's ranks page (trimmed), as served on 2026-11-07.
const row = (rank: number, characterId: number) =>
  `<tr><td style="width: 35px;" data-order="${rank}"><strong>${rank}</strong></td><td style="text-align: left">` +
  `<a href="/character/${characterId}/" rel="tooltip" title="Pilot ${characterId}"><img src="https://images.evetech.net/characters/${characterId}/portrait?size=32"></a> ` +
  `<a class="wrapplease" href="/character/${characterId}/">Pilot ${characterId}</a></td><td class="green lb-bold" data-order="853">853</td>` +
  `<td class="geen" data-order="${rank + 40}">${rank + 40}</td><td class="green" data-order="97.374429223744">97.4</td></tr>`;
const ranksPage = (ids: number[]) => `<html><a href="/character/ranks/k/all/alltime/1/">Top</a><table><tbody>${ids.map((id, i) => row(i + 1, id)).join("")}</tbody></table></html>`;

// ESI inventory flags: 11 LoSlot0, 12 LoSlot1, 19 MedSlot0, 27 HiSlot0, 28 HiSlot1, 92 RigSlot0, 87 DroneBay, 5 Cargo.
function rifterLoss(killmailId: number, victim: number, extra: Partial<ZkillKillmail> = {}, ammo = 1000): ZkillKillmail {
  return {
    killmail_id: killmailId,
    killmail_time: `2026-11-0${killmailId % 7 + 1}T12:00:00Z`,
    solar_system_id: 30002813,
    victim: {
      character_id: victim,
      corporation_id: 98000001,
      ship_type_id: 587,
      items: [
        { item_type_id: 2048, flag: 11, quantity_destroyed: 1, singleton: 0 },
        { item_type_id: 31932, flag: 12, quantity_dropped: 1, singleton: 0 },
        { item_type_id: 526, flag: 19, quantity_destroyed: 1, singleton: 0 },
        { item_type_id: 2873, flag: 27, quantity_destroyed: 1, singleton: 0 },
        { item_type_id: 185, flag: 27, quantity_destroyed: 120, singleton: 0 },
        { item_type_id: 2873, flag: 28, quantity_dropped: 1, singleton: 0 },
        { item_type_id: 185, flag: 28, quantity_dropped: 120, singleton: 0 },
        { item_type_id: 31668, flag: 92, quantity_destroyed: 1, singleton: 0 },
        { item_type_id: 2488, flag: 87, quantity_destroyed: 2, singleton: 0 },
        { item_type_id: 185, flag: 5, quantity_dropped: ammo, singleton: 0 },
        { item_type_id: 28668, flag: 5, quantity_dropped: 10, singleton: 0 },
        // Loot and a spare module: not part of the fit.
        { item_type_id: 3244, flag: 5, quantity_dropped: 1, singleton: 0 },
        // Implants (flag 89) are the pilot's, not the ship's.
        { item_type_id: 2048, flag: 89, quantity_destroyed: 1, singleton: 0 },
      ],
    },
    zkb: { hash: "abc", totalValue: 25_000_000, npc: false },
    ...extra,
  };
}

describe("parseRanks", () => {
  it("reads character ids in rank order from the ranks page", () => {
    expect(parseRanks(ranksPage([909008587, 2118806050, 92053601]))).toEqual([
      { rank: 1, characterId: 909008587 },
      { rank: 2, characterId: 2118806050 },
      { rank: 3, characterId: 92053601 },
    ]);
  });

  it("finds nothing on a page without the table", () => {
    expect(parseRanks("<html><a href='/character/123/'>x</a></html>")).toEqual([]);
  });
});

describe("fitFromLoss", () => {
  it("keeps modules in their slots and moves loaded and carried charges and paste to cargo", () => {
    const items = fitFromLoss(rifterLoss(1, 7), TYPES)!;
    expect(items).toEqual([
      { type_id: 2048, flag: "LoSlot0", quantity: 1 },
      { type_id: 31932, flag: "LoSlot1", quantity: 1 },
      { type_id: 526, flag: "MedSlot0", quantity: 1 },
      { type_id: 2873, flag: "HiSlot0", quantity: 1 },
      { type_id: 185, flag: "Cargo", quantity: 1240 },
      { type_id: 2873, flag: "HiSlot1", quantity: 1 },
      { type_id: 31668, flag: "RigSlot0", quantity: 1 },
      { type_id: 2488, flag: "DroneBay", quantity: 2 },
      { type_id: 28668, flag: "Cargo", quantity: 10 },
    ]);
  });

  it("gives no fit for a pod, an NPC kill or an empty hull", () => {
    expect(fitFromLoss({ ...rifterLoss(1, 7), victim: { character_id: 7, ship_type_id: 670, items: [] } }, TYPES)).toBeNull();
    expect(fitFromLoss(rifterLoss(1, 7, { zkb: { hash: "x", npc: true } }), TYPES)).toBeNull();
    const cargoOnly = rifterLoss(1, 7);
    cargoOnly.victim.items = cargoOnly.victim.items!.filter((item) => item.flag === 5);
    expect(fitFromLoss(cargoOnly, TYPES)).toBeNull();
  });

  it("calls two losses the same loadout whatever ammunition they carried", () => {
    const a = fitFromLoss(rifterLoss(1, 7, {}, 1000), TYPES)!;
    const b = fitFromLoss(rifterLoss(2, 7, {}, 40), TYPES)!;
    expect(loadoutKey(587, a)).toBe(loadoutKey(587, b));
    expect(loadoutKey(587, a)).not.toBe(loadoutKey(587, a.filter((item) => item.flag !== "DroneBay")));
  });
});

describe("pvpFitName", () => {
  it("fits EVE's 50 characters, shortening the pilot's name", () => {
    expect(pvpFitName("Rifter", "CrackerC")).toBe("Rifter (CrackerC)");
    const long = pvpFitName("Federation Navy Comet", "A Very Long Pilot Name Indeed Yes");
    expect(long.length).toBeLessThanOrEqual(50);
    expect(long).toMatch(/^Federation Navy Comet \(A Very.*…\)$/);
  });
});

async function profile(characterId: number): Promise<Viewer> {
  const { userId } = await completeSignIn({
    intent: "login",
    currentUserId: null,
    verified: { characterId, name: `Pilot ${characterId}`, ownerHash: `h${characterId}`, scopes: [], expiresAt: new Date() },
    tokens: { access_token: "a", expires_in: 1199 },
    affiliation: { character_id: characterId, corporation_id: 98000001 },
  });
  return (await loadViewer(userId))!;
}

/** A crawl from an earlier week, with one pilot. */
async function earlierWeek(crawledAt: string): Promise<number> {
  const [{ id }] = await db.insert(pvpCrawls).values({ crawledAt: new Date(crawledAt) }).returning({ id: pvpCrawls.id });
  await db.insert(pvpPilots).values({ crawlId: id, characterId: 1, rank: 1, name: "Last week", losses: 0 });
  return id;
}

describe("crawlPvpFits", () => {
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE users, pvp_crawls CASCADE`);
    esi.mockReset();
    vi.mocked(weeklyRanksPage).mockReset();
    vi.mocked(weeklyLosses).mockReset();
  });

  it("stores each top pilot's distinct fits as a new week, newest loss kept, earlier weeks kept", async () => {
    vi.mocked(weeklyRanksPage).mockResolvedValue(ranksPage([101, 102, 103]));
    vi.mocked(weeklyLosses).mockImplementation(async (id) =>
      id === 101
        ? [
            rifterLoss(13, 101, {}, 500),
            rifterLoss(12, 101, {}, 900),
            // Same loadout without drones: a different fit.
            { ...rifterLoss(11, 101), victim: { ...rifterLoss(11, 101).victim, items: rifterLoss(11, 101).victim.items!.filter((i) => i.flag !== 87) } },
            { ...rifterLoss(10, 101), victim: { character_id: 101, ship_type_id: 670, items: [] } },
            // zKillboard also lists a loss where 101 was not the victim only by mistake; it must not count.
            rifterLoss(9, 999),
          ]
        : id === 102
          ? [rifterLoss(20, 102)]
          : [],
    );
    const lastWeek = await earlierWeek("2026-10-31T04:41:00Z");

    const result = await crawlPvpFits(undefined, new Date("2026-11-07T04:41:00Z"));
    expect(result).toEqual({ crawlId: expect.any(Number), pilots: 3, fits: 3 });

    const { crawl, pilots } = await topPvpPilots();
    expect(crawl).toEqual({ id: result.crawlId, crawledAt: "2026-11-07T04:41:00.000Z" });
    expect(pilots.map((p) => [p.rank, p.name, p.losses, p.fits.map((f) => [f.killmailId, f.losses])])).toEqual([
      [1, "Pilot 101", 4, [[13, 2], [11, 1]]],
      [2, "Pilot 102", 1, [[20, 1]]],
      [3, "Pilot 103", 0, []],
    ]);
    const [stored] = await db.select().from(pvpFits).where(sql`killmail_id = 13`);
    expect(stored.name).toBe("Rifter (Pilot 101)");
    expect(stored.items.find((item) => item.flag === "Cargo" && item.type_id === 185)?.quantity).toBe(740);

    expect((await pvpWeeks()).map((w) => w.id)).toEqual([result.crawlId, lastWeek]);
    expect((await topPvpPilots(lastWeek)).pilots.map((p) => p.name)).toEqual(["Last week"]);
    expect(await topPvpPilots(result.crawlId + 1000)).toEqual({ crawl: null, pilots: [] });
  });

  it("replaces a crawl re-run on the same UTC day, and a fit opens from the newest week that has it", async () => {
    const lastWeek = await earlierWeek("2026-10-31T04:41:00Z");
    vi.mocked(weeklyRanksPage).mockResolvedValue(ranksPage([101]));
    vi.mocked(weeklyLosses).mockResolvedValue([rifterLoss(13, 101)]);
    const first = await crawlPvpFits(undefined, new Date("2026-11-07T04:41:00Z"));
    vi.mocked(weeklyRanksPage).mockResolvedValue(ranksPage([102, 101]));
    const rerun = await crawlPvpFits(undefined, new Date("2026-11-07T18:00:00Z"));

    expect((await pvpWeeks()).map((w) => w.id)).toEqual([rerun.crawlId, lastWeek]);
    expect(await db.select().from(pvpCrawls).where(sql`id = ${first.crawlId}`)).toEqual([]);
    // Killmail 13 was in both runs; the page shows it with the newest week's rank.
    expect((await topPvpFit(13))?.pilot.rank).toBe(2);
    expect((await topPvpFit(13))?.crawl.id).toBe(rerun.crawlId);
  });

  it("keeps the earlier weeks and saves nothing when zKillboard fails part way", async () => {
    await earlierWeek("2026-10-31T04:41:00Z");
    vi.mocked(weeklyRanksPage).mockResolvedValue(ranksPage([101, 102]));
    vi.mocked(weeklyLosses).mockResolvedValueOnce([]).mockRejectedValueOnce(new Error("zKillboard down"));
    await expect(crawlPvpFits()).rejects.toThrow("zKillboard down");
    expect((await db.select().from(pvpPilots)).map((p) => p.name)).toEqual(["Last week"]);
    expect(await pvpWeeks()).toHaveLength(1);
  });

  it("refuses a ranks page it cannot read rather than emptying the list", async () => {
    vi.mocked(weeklyRanksPage).mockResolvedValue("<html>maintenance</html>");
    await expect(crawlPvpFits()).rejects.toThrow(/no pilots/i);
  });

  it("lets a signed-in viewer copy a top fit or send it to a character", async () => {
    vi.mocked(weeklyRanksPage).mockResolvedValue(ranksPage([101]));
    vi.mocked(weeklyLosses).mockResolvedValue([rifterLoss(13, 101)]);
    await crawlPvpFits();
    const viewer = await profile(5001);

    const id = await copyTopPvpFit(viewer, 13);
    const [copy] = await db.select().from(fittings).where(sql`id = ${id}`);
    expect(copy).toMatchObject({ ownerId: viewer.userId, visibility: "private", name: "Rifter (Pilot 101)", shipTypeId: 587 });
    expect(copy.description).toContain("https://zkillboard.com/kill/13/");

    esi.mockResolvedValue({ fitting_id: 1 });
    await sendTopPvpFit(viewer, 13, 5001);
    expect(esi).toHaveBeenCalledWith("/characters/5001/fittings", expect.objectContaining({ method: "POST", body: expect.objectContaining({ ship_type_id: 587, name: "Rifter (Pilot 101)" }) }));

    await expect(copyTopPvpFit(viewer, 999)).rejects.toThrow(/not found/);
    expect(await topPvpFit(-1)).toBeNull();
  });
});
