import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { pvpCompDays } from "@/db/schema";
import { addDays, COMPS_VERSION, FIRST_DAY, LATE_WINDOW_DAYS, MAX_LATE_PER_RUN, planDays, type StoredDay } from "@/lib/pvp/comps/days";
import { isSmallGangCandidate } from "@/lib/pvp/comps/filter";
import type { RawKillmail } from "@/lib/pvp/comps/r2z2";
import { isBannedModule, isHighsec, isHull, pvpType, systemSecurity } from "@/lib/pvp/comps/static-data";

const r2z2 = vi.hoisted(() => ({ r2z2Totals: vi.fn(), r2z2Day: vi.fn() }));
vi.mock("@/lib/pvp/comps/r2z2", () => r2z2);

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

function killmail(overrides: { system?: number; ship?: number; victim?: Partial<RawKillmail["victim"]>; attackers?: RawKillmail["attackers"] } = {}): RawKillmail {
  return {
    killmail_id: 1,
    killmail_time: "2026-11-24T12:00:00Z",
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
    await db.execute(sql`TRUNCATE pvp_comp_days`);
    r2z2.r2z2Totals.mockReset().mockResolvedValue(new Map());
    r2z2.r2z2Day.mockReset().mockImplementation(async () => [killmail(), killmail({ system: JITA })]);
  });

  afterEach(() => vi.useRealTimers());

  const now = new Date("2026-08-04T07:00:00Z");

  it("reads and records each pending day", async () => {
    const result = await syncCompDays(240_000, now);
    expect(result).toEqual({ days: 3, pending: 0, killmails: 6, kept: 3 });
    expect(r2z2.r2z2Day.mock.calls.map(([day]) => day)).toEqual(["2026-08-01", "2026-08-02", "2026-08-03"]);
    const rows = await db.select().from(pvpCompDays).orderBy(pvpCompDays.day);
    expect(rows.map(({ day, killmails, kept, version }) => ({ day, killmails, kept, version }))).toEqual([
      { day: "2026-08-01", killmails: 2, kept: 1, version: COMPS_VERSION },
      { day: "2026-08-02", killmails: 2, kept: 1, version: COMPS_VERSION },
      { day: "2026-08-03", killmails: 2, kept: 1, version: COMPS_VERSION },
    ]);

    // Nothing left: the next run reads nothing.
    r2z2.r2z2Day.mockClear();
    expect(await syncCompDays(240_000, now)).toEqual({ days: 0, pending: 0, killmails: 0, kept: 0 });
    expect(r2z2.r2z2Day).not.toHaveBeenCalled();
  });

  it("reads a day again when zKillboard's count for it changes, replacing its row", async () => {
    r2z2.r2z2Totals.mockResolvedValue(new Map([["2026-08-02", 2]]));
    await syncCompDays(240_000, now);
    r2z2.r2z2Totals.mockResolvedValue(new Map([["2026-08-02", 3]]));
    r2z2.r2z2Day.mockImplementation(async () => [killmail(), killmail(), killmail({ system: JITA })]);
    expect(await syncCompDays(240_000, now)).toEqual({ days: 1, lateRedone: 1, pending: 0, killmails: 3, kept: 2 });
    const [row] = await db.select().from(pvpCompDays).where(sql`${pvpCompDays.day} = '2026-08-02'`);
    expect(row).toMatchObject({ killmails: 3, reported: 3, kept: 2 });
  });

  it("does not read a day again when its file never matches zKillboard's count", async () => {
    // zKillboard can count a few more killmails than the file holds, for good.
    r2z2.r2z2Totals.mockResolvedValue(new Map([["2026-08-02", 5]]));
    await syncCompDays(240_000, now);
    r2z2.r2z2Day.mockClear();
    expect(await syncCompDays(240_000, now)).toEqual({ days: 0, pending: 0, killmails: 0, kept: 0 });
    expect(r2z2.r2z2Day).not.toHaveBeenCalled();
  });

  it("skips a day with no file yet and leaves it for the next run", async () => {
    r2z2.r2z2Day.mockImplementation(async (day: string) => (day === "2026-08-03" ? null : [killmail()]));
    expect(await syncCompDays(240_000, now)).toEqual({ days: 2, pending: 0, notPublished: "2026-08-03", killmails: 2, kept: 2 });
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
    expect(await syncCompDays(240_000, now)).toEqual({ days: 2, pending: 1, killmails: 2, kept: 2 });
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
