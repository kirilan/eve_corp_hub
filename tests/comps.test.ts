import { readFileSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { pvpCompDays, pvpCompFits, pvpCompHullLosses, pvpCompMonths, pvpCompSides } from "@/db/schema";
import { addDays, COMPS_VERSION, FIRST_DAY, LATE_WINDOW_DAYS, MAX_LATE_PER_RUN, planDays, type StoredDay } from "@/lib/pvp/comps/days";
import { compKill, groupFights, isWin, lossesAt, PRICE_CAP, processDay, splitSides, type CompKill } from "@/lib/pvp/comps/fights";
import { isSmallGangCandidate } from "@/lib/pvp/comps/filter";
import type { RawKillmail } from "@/lib/pvp/comps/r2z2";
import { mixLabel, mixOf, roleOf } from "@/lib/pvp/comps/roles";
import { scoreComps, wilsonLow, type ScoredFit, type ScoredSide } from "@/lib/pvp/comps/score";
import { isBannedModule, isHighsec, isHull, pvpType, systemSecurity } from "@/lib/pvp/comps/static-data";

const r2z2 = vi.hoisted(() => ({ r2z2Totals: vi.fn(), r2z2Day: vi.fn() }));
vi.mock("@/lib/pvp/comps/r2z2", () => r2z2);
vi.mock("@/lib/pvp/comps/prices", () => ({ compPrices: vi.fn(async () => new Map()) }));
vi.mock("next/cache", () => ({ cacheLife: () => {}, cacheTag: () => {}, io: async () => {} }));
vi.mock("@/lib/eve/types", () => ({ typeNames: vi.fn(async (ids: number[]) => new Map(ids.map((id) => [id, `Type ${id}`]))) }));

const { syncCompDays } = await import("@/lib/pvp/comps/sync");

const JITA = 30000142;
const TAMA = 30002813;
const THERA = 31000005;
const STILETTO = 11198;
const RIFTER = 587;
const CAPSULE = 670;

describe("static data", () => {
  it("rounds security the way the game shows it", () => {
    expect(systemSecurity(JITA)).toBe(0.9);
    expect(systemSecurity(TAMA)).toBe(0.3);
    expect(systemSecurity(THERA)).toBe(-1);
    // 0.4489 shows as 0.4 (lowsec), 0.4502 as 0.5 (highsec).
    expect(isHighsec(30002246)).toBe(false);
    expect(isHighsec(30004978)).toBe(true);
    // Just above 0.0 shows as 0.1: lowsec.
    expect(systemSecurity(30004309)).toBe(0.1);
    // A system the export does not know is left out like highsec.
    expect(isHighsec(1)).toBe(true);
  });

  it("knows hulls, and officer, deadspace and abyssal modules", () => {
    expect(pvpType(STILETTO)).toEqual({ groupId: 831, categoryId: 6, metaGroupId: 2, basePrice: expect.any(Number) });
    expect(isHull(STILETTO)).toBe(true);
    expect(isHull(CAPSULE)).toBe(false);
    expect(isHull(527)).toBe(false); // Stasis Webifier II
    expect(isBannedModule(527)).toBe(false);
    expect(isBannedModule(14703)).toBe(true); // officer
    expect(isBannedModule(19200)).toBe(true); // deadspace
    expect(isBannedModule(47702)).toBe(true); // abyssal
  });
});

function killmail(overrides: { id?: number; system?: number; ship?: number; victim?: Partial<RawKillmail["victim"]>; attackers?: RawKillmail["attackers"] } = {}): RawKillmail {
  return {
    killmail_id: overrides.id ?? 1,
    killmail_time: "2026-08-01T12:00:00Z",
    solar_system_id: overrides.system ?? TAMA,
    victim: { character_id: 100, corporation_id: 98000001, alliance_id: 99000001, ship_type_id: overrides.ship ?? RIFTER, ...overrides.victim },
    attackers: overrides.attackers ?? [{ character_id: 200, corporation_id: 98000002, alliance_id: 99000002, ship_type_id: STILETTO }],
  };
}

describe("isSmallGangCandidate", () => {
  it("keeps a player kill of a piloted hull outside highsec, wormholes included", () => {
    expect(isSmallGangCandidate(killmail())).toBe(true);
    expect(isSmallGangCandidate(killmail({ system: THERA }))).toBe(true);
  });

  it("drops highsec, capsules, non-ships and empty hulls", () => {
    expect(isSmallGangCandidate(killmail({ system: JITA }))).toBe(false);
    expect(isSmallGangCandidate(killmail({ ship: CAPSULE }))).toBe(false);
    expect(isSmallGangCandidate(killmail({ ship: 35826 }))).toBe(false); // Azbel
    expect(isSmallGangCandidate(killmail({ victim: { character_id: undefined } }))).toBe(false);
  });

  it("drops NPC-only kills and awoxing", () => {
    expect(isSmallGangCandidate(killmail({ attackers: [{ corporation_id: 1000125, ship_type_id: 1 }] }))).toBe(false);
    expect(isSmallGangCandidate(killmail({ attackers: [{ character_id: 200, corporation_id: 98000001, ship_type_id: STILETTO }] }))).toBe(false);
    expect(isSmallGangCandidate(killmail({ attackers: [{ character_id: 200, corporation_id: 98000009, alliance_id: 99000001 }] }))).toBe(false);
    // One outsider among corp mates is enough.
    expect(
      isSmallGangCandidate(
        killmail({ attackers: [{ character_id: 200, corporation_id: 98000001 }, { character_id: 300, corporation_id: 98000003 }] }),
      ),
    ).toBe(true);
  });

  it("treats a victim without an alliance by corporation alone", () => {
    const victim = { alliance_id: undefined };
    expect(isSmallGangCandidate(killmail({ victim, attackers: [{ character_id: 200, corporation_id: 98000002, alliance_id: 99000001 }] }))).toBe(true);
    expect(isSmallGangCandidate(killmail({ victim, attackers: [{ character_id: 200, corporation_id: 98000001 }] }))).toBe(false);
  });
});

describe("planDays", () => {
  const today = "2026-11-25";
  const read = (day: string, reported: number | null = 10, version = COMPS_VERSION): [string, StoredDay] => [day, { day, reported, version }];
  const everyDay = (until: string) => {
    const out: [string, StoredDay][] = [];
    for (let day = FIRST_DAY; day < until; day = addDays(day, 1)) out.push(read(day));
    return new Map(out);
  };

  it("reads every day from the first to yesterday, oldest first, never today", () => {
    const plan = planDays(today, new Map(), new Map());
    expect(plan[0]).toEqual({ day: FIRST_DAY, reason: "new" });
    expect(plan.at(-1)).toEqual({ day: "2026-11-24", reason: "new" });
    expect(plan).toHaveLength(116);
  });

  it("reads again what an older version read, with the backlog", () => {
    const stored = everyDay(today);
    stored.set("2026-09-10", { day: "2026-09-10", reported: 10, version: COMPS_VERSION - 1 });
    expect(planDays(today, stored, new Map())).toEqual([{ day: "2026-09-10", reason: "version" }]);
  });

  it("picks up late killmails in the recent window only, newest first, a few per run", () => {
    const stored = everyDay(today);
    const totals = new Map([...stored.keys()].map((day) => [day, 11]));
    const plan = planDays(today, stored, totals);
    expect(plan).toHaveLength(MAX_LATE_PER_RUN);
    expect(plan.map((p) => p.day)).toEqual(["2026-11-24", "2026-11-23", "2026-11-22"]);
    expect(plan.every((p) => p.reason === "late")).toBe(true);

    // Outside the window a changed count is left alone; a day zKillboard has no count for too.
    const old = new Map([[addDays(today, -LATE_WINDOW_DAYS - 1), 11]]);
    expect(planDays(today, stored, old)).toEqual([]);
  });

  it("puts the backlog before late killmails", () => {
    const stored = everyDay("2026-11-20");
    const plan = planDays(today, stored, new Map([["2026-11-19", 11]]));
    expect(plan.map((p) => p.reason)).toEqual(["new", "new", "new", "new", "new", "late"]);
  });
});

describe("syncCompDays", () => {
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE pvp_comp_days, pvp_comp_sides, pvp_comp_fits, pvp_comp_hull_losses, pvp_comp_months`);
    r2z2.r2z2Totals.mockReset().mockResolvedValue(new Map());
    r2z2.r2z2Day.mockReset().mockImplementation(async () => [killmail(), killmail({ system: JITA })]);
  });

  afterEach(() => vi.useRealTimers());

  const now = new Date("2026-08-04T07:00:00Z");

  it("reads and records each pending day", async () => {
    const result = await syncCompDays(240_000, now);
    expect(result).toEqual({ days: 3, pending: 0, killmails: 6, kept: 3, sides: 0 });
    expect(r2z2.r2z2Day.mock.calls.map(([day]) => day)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    const rows = await db.select().from(pvpCompDays).orderBy(pvpCompDays.day);
    expect(rows.map(({ day, killmails, kept, version }) => ({ day, killmails, kept, version }))).toEqual([
      { day: "2026-08-01", killmails: 2, kept: 1, version: COMPS_VERSION },
      { day: "2026-08-02", killmails: 2, kept: 1, version: COMPS_VERSION },
      { day: "2026-08-03", killmails: 2, kept: 1, version: COMPS_VERSION },
    ]);

    // Nothing left: the next run reads nothing.
    r2z2.r2z2Day.mockClear();
    expect(await syncCompDays(240_000, now)).toEqual({ days: 0, pending: 0, killmails: 0, kept: 0, sides: 0 });
    expect(r2z2.r2z2Day).not.toHaveBeenCalled();
  });

  it("reads a day again when zKillboard's count for it changes, replacing its row", async () => {
    r2z2.r2z2Totals.mockResolvedValue(new Map([["2026-08-02", 2]]));
    await syncCompDays(240_000, now);
    r2z2.r2z2Totals.mockResolvedValue(new Map([["2026-08-02", 3]]));
    r2z2.r2z2Day.mockImplementation(async () => [killmail(), killmail({ id: 2 }), killmail({ system: JITA })]);
    expect(await syncCompDays(240_000, now)).toEqual({ days: 1, lateRedone: 1, pending: 0, killmails: 3, kept: 2, sides: 0 });
    const [row] = await db.select().from(pvpCompDays).where(sql`${pvpCompDays.day} = '2026-08-02'`);
    expect(row).toMatchObject({ killmails: 3, reported: 3, kept: 2 });
  });

  it("does not read a day again when its file never matches zKillboard's count", async () => {
    // zKillboard can count a few more killmails than the file holds, for good.
    r2z2.r2z2Totals.mockResolvedValue(new Map([["2026-08-02", 5]]));
    await syncCompDays(240_000, now);
    r2z2.r2z2Day.mockClear();
    expect(await syncCompDays(240_000, now)).toEqual({ days: 0, pending: 0, killmails: 0, kept: 0, sides: 0 });
    expect(r2z2.r2z2Day).not.toHaveBeenCalled();
  });

  it("skips a day with no file yet and leaves it for the next run", async () => {
    r2z2.r2z2Day.mockImplementation(async (day: string) => (day === "2026-08-03" ? null : [killmail()]));
    expect(await syncCompDays(240_000, now)).toEqual({ days: 2, pending: 0, notPublished: "2026-08-03", killmails: 2, kept: 2, sides: 0 });
    expect(await db.$count(pvpCompDays)).toBe(2);
  });

  it("stops starting days when its time runs out, and says how many are left", async () => {
    // Each day takes 100 s; with 240 s and a minute kept in hand, two fit.
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    r2z2.r2z2Day.mockImplementation(async () => {
      clock += 100_000;
      return [killmail()];
    });
    expect(await syncCompDays(240_000, now)).toEqual({ days: 2, pending: 1, killmails: 2, kept: 2, sides: 0 });
    vi.mocked(Date.now).mockRestore();
  });

  it("fails the run on a broken download, keeping the days already read", async () => {
    r2z2.r2z2Day.mockImplementation(async (day: string) => {
      if (day === "2026-08-02") throw new Error("R2Z2 day 2026-08-02 failed (500)");
      return [killmail()];
    });
    await expect(syncCompDays(240_000, now)).rejects.toThrow("failed (500)");
    expect((await db.select().from(pvpCompDays)).map((row) => row.day)).toEqual(["2026-08-01"]);
  });
});

// A recorded fight: 30 Oct 2026, 05:31 to 05:40 UTC in a lowsec system, six kills. Three Retributions
// of one alliance against four pilots of a corporation, an alliance and an NPC corporation, who end up
// on one side because they shot the same Retributions.
const RECORDED: RawKillmail[] = JSON.parse(readFileSync(new URL("./fixtures/comps-fight.json", import.meta.url), "utf8"));
const RETRIBUTION = 11393;

/** The recorded fight moved to another day and time of day. */
const recordedOn = (at: string) =>
  RECORDED.map((km, i) => ({ ...km, killmail_time: new Date(Date.parse(at) + i * 60_000).toISOString().replace(".000", "") }));

/** A kill with the attackers given as [character, corporation, alliance?, ship?]. */
function kill(id: number, t: number, victim: [number, number, number?, number?], attackers: [number, number, number?, number?][], system = TAMA): CompKill {
  const group = ([character, corp, alliance]: [number, number, number?, number?]) => (alliance ? `a${alliance}` : corp >= 2_000_000 ? `c${corp}` : `p${character}`);
  return {
    id,
    t,
    system,
    victim: { character: victim[0], group: group(victim), ship: victim[3] ?? RIFTER },
    attackers: attackers.map((a) => [a[0], group(a), a[3] ?? STILETTO]),
    value: 10_000_000,
    fit: null,
  };
}

describe("roles", () => {
  it("names a hull's role by its group", () => {
    expect(roleOf(STILETTO)).toBe("tackle");
    expect(roleOf(11978)).toBe("logi"); // Scimitar
    expect(roleOf(11963)).toBe("ewar"); // Rapier
    expect(roleOf(22466)).toBe("links"); // Astarte
    expect(roleOf(RETRIBUTION)).toBe("dps");
  });

  it("counts pilots per role, unknown hulls as DPS", () => {
    expect(mixOf(5, [STILETTO, RIFTER, 11978])).toEqual([3, 1, 1, 0, 0]);
    expect(mixLabel([3, 2, 0, 1, 0])).toBe("3 DPS + 2 tackle + 1 EWAR");
  });
});

describe("fights", () => {
  it("prices a loss and keeps its fit only under the cap and without banned modules", () => {
    const km = RECORDED[0];
    const prices = new Map([[RETRIBUTION, 20_000_000]]);
    const priced = compKill(km, prices);
    expect(priced.value).toBeGreaterThan(20_000_000);
    expect(priced.fit?.some((item) => item.flag.startsWith("HiSlot"))).toBe(true);
    expect(compKill(km, new Map([[RETRIBUTION, PRICE_CAP]])).fit).toBeNull();
    const officer = { ...km, victim: { ...km.victim, items: [...km.victim.items!, { item_type_id: 14703, flag: 19, quantity_destroyed: 1 }] } };
    expect(compKill(officer, prices).fit).toBeNull();
  });

  it("groups kills in one system 15 minutes apart at most", () => {
    const a = kill(1, 0, [1, 2_000_001], [[2, 2_000_002]]);
    const b = kill(2, 900, [3, 2_000_001], [[2, 2_000_002]]);
    const c = kill(3, 1801, [4, 2_000_001], [[2, 2_000_002]]);
    const elsewhere = kill(4, 100, [5, 2_000_001], [[2, 2_000_002]], JITA);
    expect(groupFights([c, elsewhere, b, a]).map((fight) => fight.map((k) => k.id))).toEqual([[1, 2], [4], [3]]);
  });

  it("puts groups that shoot the same target on one side, without awoxers", () => {
    const fight = [
      // Corp 2,000,002 and alliance 99 kill a pilot of corp 2,000,001, helped by one of his own corp.
      kill(1, 0, [1, 2_000_001], [[2, 2_000_002, undefined, STILETTO], [3, 2_000_003, 99, RIFTER], [4, 2_000_001]]),
      // Its pilot in a capsule, killed: a hull nobody saw him fly.
      kill(2, 60, [5, 2_000_009, undefined, RIFTER], [[1, 2_000_001, undefined, CAPSULE]]),
    ];
    const [victims, attackers, lone] = splitSides(fight);
    expect(victims).toMatchObject({ pilots: 1, enemies: 3, iskLost: 10_000_000, iskKilled: 10_000_000, hulls: [RIFTER] });
    expect(attackers).toMatchObject({ pilots: 2, enemies: 2, iskKilled: 10_000_000, iskLost: 0, hulls: [STILETTO, RIFTER] });
    expect(lone).toMatchObject({ pilots: 1, hulls: [RIFTER], iskLost: 10_000_000 });
  });

  it("splits the recorded fight into its two sides", () => {
    const result = processDay("2026-10-30", RECORDED, [], new Map());
    expect(result.kept).toBe(6);
    expect(result.carry).toEqual([]);
    const [retributions, others] = result.sides;
    expect(retributions).toMatchObject({ fightId: 139532539, side: 0, day: "2026-10-30", pilots: 3, enemies: 4, hulls: [RETRIBUTION, RETRIBUTION, RETRIBUTION] });
    // The Jaguar pilot also flew a Stiletto; the hull he lost is his. The NPC-corp pilot lost nothing.
    expect(others).toMatchObject({ fightId: 139532539, side: 1, pilots: 4, enemies: 3, hulls: [24702, 587, 626, 3756] });
    expect(retributions.iskKilled).toBe(others.iskLost);
    expect(others.iskKilled).toBe(retributions.iskLost);
    // Fits come from the fair side that won.
    const winner = isWin(retributions) ? retributions : others;
    expect(result.fits.length).toBeGreaterThan(0);
    expect(result.fits.every((fit) => fit.side === winner.side && fit.fightId === 139532539)).toBe(true);
    expect([...result.hullLosses.keys()].sort()).toEqual([587, 626, RETRIBUTION, 24702].sort());
  });

  it("carries a fight still going at midnight into the next day, which stores it under its first day", () => {
    const late = recordedOn("2026-10-30T23:50:00Z");
    const first = processDay("2026-10-30", late.slice(0, 3), [], new Map());
    expect(first.sides).toEqual([]);
    expect(first.carry.map((k) => k.id)).toEqual([139532539, 139532554, 139532560]);
    const second = processDay("2026-10-31", late.slice(3), first.carry, new Map());
    expect(second.kept).toBe(3);
    expect(second.carry).toEqual([]);
    expect(second.sides.map((side) => [side.fightId, side.day, side.pilots])).toEqual([
      [139532539, "2026-10-30", 3],
      [139532539, "2026-10-30", 4],
    ]);
    // Only the day's own losses count toward its hull losses.
    expect(second.hullLosses.get(RETRIBUTION)).toEqual({ losses: 2, affordable: 2, under500m: 2, under200m: 2 });
  });

  it("counts each hull's losses under every price cap", () => {
    const day = recordedOn("2026-10-30T10:00:00Z");
    const result = processDay("2026-10-30", day, [], new Map([[RETRIBUTION, 300_000_000]]));
    const retributions = result.hullLosses.get(RETRIBUTION)!;
    expect(retributions.losses).toBeGreaterThan(0);
    expect(retributions).toEqual({ losses: retributions.losses, affordable: retributions.losses, under500m: retributions.losses, under200m: 0 });
    expect(lossesAt(retributions, 500)).toEqual({ losses: retributions.losses, affordable: retributions.losses });
    expect(lossesAt(retributions, 200)).toEqual({ losses: retributions.losses, affordable: 0 });
  });
});

describe("scoreComps", () => {
  let next = 0;
  const side = (pilots: number, hulls: number[], win: boolean, enemies = pilots): ScoredSide => ({
    fightId: ++next,
    side: 0,
    pilots,
    enemies,
    iskKilled: win ? 2 : 1,
    iskLost: win ? 1 : 2,
    hulls,
  });
  const many = (count: number, wins: number, make: (win: boolean) => ScoredSide) => Array.from({ length: count }, (_, i) => make(i < wins));
  const CHEAP = { losses: 10, affordable: 10 };
  const losses = new Map([
    [RIFTER, CHEAP],
    [STILETTO, CHEAP],
    [11978, CHEAP],
    [22466, CHEAP],
    // A Loki: most of its losses cost more than 1B.
    [29990, { losses: 10, affordable: 4 }],
  ]);

  it("gives the Wilson low bound", () => {
    expect(wilsonLow(8, 10)).toBeCloseTo(0.4902, 4);
    expect(wilsonLow(0, 0)).toBe(0);
  });

  it("ranks mixes with enough fair fights by the low end of their win rate", () => {
    const sides = [
      // 3 pilots: 2 DPS + 1 tackle wins 24 of 40; 3 DPS wins 21 of 30 (better rate, fewer fights).
      ...many(40, 24, (win) => side(3, [RIFTER, RIFTER, STILETTO], win)),
      ...many(30, 21, (win) => side(3, [RIFTER, RIFTER, RIFTER], win)),
      // Too few fights, unfair fights, and over-cap or unpriced hulls are left out.
      ...many(29, 29, (win) => side(3, [STILETTO, STILETTO, STILETTO], win)),
      ...many(40, 40, (win) => side(3, [RIFTER, RIFTER, RIFTER], win, 1)),
      ...many(5, 5, (win) => side(3, [RIFTER, RIFTER, 29990], win)),
      ...many(5, 5, (win) => side(3, [RIFTER, RIFTER, 670], win)),
    ];
    const result = scoreComps(sides, losses, []);
    expect(result.sides).toBe(40 + 30 + 29);
    expect(result.overCap).toBe(10);
    const three = result.sizes.find((size) => size.pilots === 3)!;
    expect(three.sides).toBe(99);
    expect(three.mixes.map((stat) => [mixLabel(stat.mix), stat.wins, stat.fights])).toEqual([
      ["3 DPS", 21, 30],
      ["2 DPS + 1 tackle", 24, 40],
    ]);
    expect(three.mixes[0].low).toBeCloseTo(wilsonLow(21, 30));
  });

  it("grows the core one pilot at a time, swapping when no mix grows from the last", () => {
    const sides = [
      ...many(30, 20, (win) => side(3, [RIFTER, STILETTO, 22466], win)),
      // 4 pilots: the best mix does not contain the 3-pilot one; the second does.
      ...many(30, 29, (win) => side(4, [RIFTER, RIFTER, RIFTER, RIFTER], win)),
      ...many(30, 18, (win) => side(4, [RIFTER, RIFTER, STILETTO, 22466], win)),
      // 5 pilots: nothing grows from the 4-pilot step.
      ...many(30, 20, (win) => side(5, [RIFTER, RIFTER, RIFTER, STILETTO, STILETTO], win)),
    ];
    expect(scoreComps(sides, losses, []).growth).toEqual([
      { pilots: 3, mix: [1, 1, 0, 0, 1], swap: false },
      { pilots: 4, mix: [2, 1, 0, 0, 1], swap: false },
      { pilots: 5, mix: [3, 2, 0, 0, 0], swap: true },
    ]);
  });

  it("ranks hulls per role across gang sizes, logi by how often it flew, with the fit winners lost most", () => {
    const sides = [
      ...many(20, 15, (win) => side(3, [RIFTER, STILETTO, 11978], win)),
      ...many(20, 10, (win) => side(5, [RIFTER, RIFTER, STILETTO, STILETTO, RIFTER], win)),
    ];
    const winner = sides[0];
    const loser = sides[19];
    const fit = (killmailId: number, of: ScoredSide, loadout: string): ScoredFit => ({
      killmailId,
      fightId: of.fightId,
      side: of.side,
      characterId: 1,
      shipTypeId: STILETTO,
      items: [],
      loadout,
      value: 1,
    });
    const fits = [fit(10, winner, "a"), fit(11, winner, "b"), fit(12, sides[1], "b"), fit(13, loser, "a"), fit(14, loser, "a")];
    const result = scoreComps(sides, losses, fits);
    expect(result.hulls.dps.map((stat) => [stat.typeId, stat.wins, stat.fights])).toEqual([[RIFTER, 25, 40]]);
    expect(result.hulls.tackle.map((stat) => stat.typeId)).toEqual([STILETTO]);
    // 20 fights is under the minimum, but logi is listed by appearances.
    expect(result.hulls.logi.map((stat) => [stat.typeId, stat.fights])).toEqual([[11978, 20]]);
    // Loadout "b" was lost twice by winning sides, "a" once (the losing side's do not count).
    expect(result.hulls.tackle[0].fit).toEqual({ killmailId: 12, characterId: 1, items: [], value: 1, losses: 2 });
  });

  it("keeps fits over a cheaper cap out of the hull's example fit", () => {
    const sides = many(30, 30, (win) => side(3, [RIFTER, STILETTO, STILETTO], win));
    const fit = (killmailId: number, value: number, loadout: string): ScoredFit => ({
      killmailId,
      fightId: sides[0].fightId,
      side: 0,
      characterId: 1,
      shipTypeId: STILETTO,
      items: [],
      loadout,
      value,
    });
    // Lost twice at 300M, once at 100M: at 1B the pricier loadout shows, at 200M only the cheap one.
    const fits = [fit(20, 300_000_000, "pricey"), fit(21, 300_000_000, "pricey"), fit(22, 100_000_000, "cheap")];
    expect(scoreComps(sides, losses, fits).hulls.tackle[0].fit?.killmailId).toBe(21);
    expect(scoreComps(sides, losses, fits, 200).hulls.tackle[0].fit?.killmailId).toBe(22);
  });
});

describe("syncCompDays with fights", () => {
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE pvp_comp_days, pvp_comp_sides, pvp_comp_fits, pvp_comp_hull_losses, pvp_comp_months`);
    r2z2.r2z2Totals.mockReset().mockResolvedValue(new Map());
    r2z2.r2z2Day.mockReset().mockImplementation(async (day: string) => (day === "2026-08-20" ? recordedOn("2026-08-20T10:00:00Z") : []));
  });

  it("stores a day's sides, fits and hull losses, and saves a month once the next one's first day is read", async () => {
    expect(await syncCompDays(240_000, new Date("2026-09-01T07:00:00Z"))).toMatchObject({ days: 31, sides: 2 });
    expect(await db.$count(pvpCompSides)).toBe(2);
    expect(await db.$count(pvpCompFits)).toBeGreaterThan(0);
    expect(await db.$count(pvpCompHullLosses)).toBe(4);
    // 1 September is not read yet: August is not saved.
    expect(await db.$count(pvpCompMonths)).toBe(0);

    expect(await syncCompDays(240_000, new Date("2026-09-02T07:00:00Z"))).toMatchObject({ days: 1, monthsSaved: "2026-08" });
    // Saved once per price cap.
    expect((await db.select().from(pvpCompMonths)).map((row) => row.cap).sort()).toEqual([1000, 200, 500]);
    const [august] = await db.select().from(pvpCompMonths).where(eq(pvpCompMonths.cap, 1000));
    expect(august.month).toBe("2026-08-01");
    // The Retributions count; the other side flew a hull nobody lost that month, so it cannot be priced.
    expect(august.results).toMatchObject({ sides: 1, overCap: 1 });
    expect(august.results.hulls.dps.map((stat) => stat.typeId)).toEqual([]);
  });

  it("fills in a cap a saved month lacks once its days are read again, keeping the caps it has", async () => {
    await syncCompDays(240_000, new Date("2026-09-02T07:00:00Z"));
    // A month saved before the cheaper caps existed.
    await db.delete(pvpCompMonths).where(sql`${pvpCompMonths.cap} <> 1000`);
    const [before] = await db.select().from(pvpCompMonths);
    expect(await syncCompDays(240_000, new Date("2026-09-02T07:00:00Z"))).toMatchObject({ monthsSaved: "2026-08" });
    expect(await db.$count(pvpCompMonths)).toBe(3);
    const [after] = await db.select().from(pvpCompMonths).where(eq(pvpCompMonths.cap, 1000));
    expect(after.savedAt).toEqual(before.savedAt);
  });

  it("deletes rows 40 days old only once their month is saved", async () => {
    await syncCompDays(240_000, new Date("2026-09-01T07:00:00Z"));
    // 40 days on, August is still not saved (1 September was never read): its rows stay.
    r2z2.r2z2Totals.mockResolvedValue(new Map());
    await db.delete(pvpCompDays).where(sql`${pvpCompDays.day} >= '2026-09-01'`);
    r2z2.r2z2Day.mockImplementation(async (day: string) => (day === "2026-09-01" ? null : []));
    await syncCompDays(240_000, new Date("2026-10-15T07:00:00Z"));
    expect(await db.$count(pvpCompSides)).toBe(2);

    r2z2.r2z2Day.mockImplementation(async () => []);
    expect(await syncCompDays(240_000, new Date("2026-10-15T07:00:00Z"))).toMatchObject({ monthsSaved: "2026-08 2026-09" });
    expect(await db.$count(pvpCompSides)).toBe(0);
    expect(await db.$count(pvpCompHullLosses)).toBe(0);
  });

  it("reads the next day again when a late killmail changes what went past midnight", async () => {
    const late = recordedOn("2026-08-01T23:50:00Z");
    r2z2.r2z2Day.mockImplementation(async (day: string) => (day === "2026-08-01" ? late.slice(0, 2) : day === "2026-08-02" ? late.slice(3) : []));
    r2z2.r2z2Totals.mockResolvedValue(new Map([["2026-08-01", 2]]));
    const now = new Date("2026-08-03T07:00:00Z");
    await syncCompDays(240_000, now);
    expect(await db.$count(pvpCompSides)).toBe(2);

    // A third kill turns up on 1 August: the 2nd is read again on the next run and finishes the fight with it.
    r2z2.r2z2Day.mockImplementation(async (day: string) => (day === "2026-08-01" ? late.slice(0, 3) : day === "2026-08-02" ? late.slice(3) : []));
    r2z2.r2z2Totals.mockResolvedValue(new Map([["2026-08-01", 3]]));
    expect(await syncCompDays(240_000, now)).toMatchObject({ days: 1, lateRedone: 1 });
    expect(await syncCompDays(240_000, now)).toMatchObject({ days: 1 });
    const losses = await db.select().from(pvpCompSides);
    expect(losses.map((row) => [row.day, row.processedDay, row.pilots]).sort()).toEqual([
      ["2026-08-01", "2026-08-02", 3],
      ["2026-08-01", "2026-08-02", 4],
    ]);
    expect(await syncCompDays(240_000, now)).toMatchObject({ days: 0 });
  });
});

describe("comps page data", () => {
  beforeEach(async () => {
    await db.execute(sql`TRUNCATE pvp_comp_days, pvp_comp_sides, pvp_comp_fits, pvp_comp_hull_losses, pvp_comp_months`);
    r2z2.r2z2Totals.mockReset().mockResolvedValue(new Map());
    r2z2.r2z2Day.mockReset().mockImplementation(async (day: string) => (day === "2026-08-20" ? recordedOn("2026-08-20T10:00:00Z") : []));
  });

  it("lists saved months, reads the live window and a month, and finds a fit in either", async () => {
    const { compFit, compMonths, liveComps, monthComps } = await import("@/lib/pvp/comps/view");
    await syncCompDays(240_000, new Date("2026-09-02T07:00:00Z"));
    expect(await compMonths()).toEqual(["2026-08"]);
    const live = await liveComps("2026-09-02");
    expect(live).toMatchObject({ from: "2026-08-03", to: "2026-09-01", results: { sides: 1, overCap: 1 } });
    expect(await monthComps("2026-08")).toMatchObject({ from: "2026-08-01", to: "2026-08-31", results: { sides: 1 } });
    expect(await monthComps("2026-08", 200)).toMatchObject({ from: "2026-08-01", results: { sides: expect.any(Number) } });
    expect((await liveComps("2026-09-02", 500))?.results.sides).toEqual(expect.any(Number));
    expect(await monthComps("2026-07")).toBeNull();
    expect(await monthComps("junk")).toBeNull();

    const [stored] = await db.select().from(pvpCompFits).limit(1);
    expect(await compFit(stored.killmailId)).toMatchObject({ killmailId: stored.killmailId, shipTypeId: stored.shipTypeId, role: "dps", month: null, losses: null });
    expect(await compFit(1)).toBeNull();
  });
});
