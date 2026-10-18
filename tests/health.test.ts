import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { cronRuns } from "@/db/schema";
import { cronStatus, describeSchedule, nextRun, recordCronRun, runState } from "@/lib/cron";
import { systemHealth } from "@/lib/health";

const esi = vi.hoisted(() => vi.fn());
vi.mock("@/lib/eve/esi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/eve/esi")>()),
  esi,
}));

const JOB = "/api/cron/income";

beforeEach(async () => {
  await db.execute(sql`TRUNCATE cron_runs`);
  esi.mockReset();
});

describe("schedules", () => {
  const at = (iso: string) => new Date(iso);

  it("finds the next daily and hourly run in UTC", () => {
    expect(nextRun("17 3 * * *", at("2026-10-18T02:00:00Z"))).toEqual(at("2026-10-18T03:17:00Z"));
    expect(nextRun("17 3 * * *", at("2026-10-18T03:17:00Z"))).toEqual(at("2026-10-19T03:17:00Z"));
    expect(nextRun("5 * * * *", at("2026-10-18T10:30:00Z"))).toEqual(at("2026-10-18T11:05:00Z"));
    expect(nextRun("*/5 * * * *", at("2026-10-18T10:30:00Z"))).toBeNull();
    expect(nextRun("0 3 * * 1", at("2026-10-18T10:30:00Z"))).toBeNull();
  });

  it("describes them, or shows the schedule as written", () => {
    expect(describeSchedule("17 3 * * *")).toBe("Daily at 03:17 UTC");
    expect(describeSchedule("5 * * * *")).toBe("Hourly at :05");
    expect(describeSchedule("0 3 * * 1")).toBe("0 3 * * 1");
  });

  it("calls a run that never ended killed once it outlives any function", () => {
    const now = at("2026-10-18T12:00:00Z");
    expect(runState({ ok: null, finishedAt: null, startedAt: at("2026-10-18T11:58:00Z") }, now)).toBe("running");
    expect(runState({ ok: null, finishedAt: null, startedAt: at("2026-10-18T11:00:00Z") }, now)).toBe("killed");
    expect(runState({ ok: false, finishedAt: now, startedAt: now }, now)).toBe("failed");
  });
});

describe("recordCronRun", () => {
  it("records a run's result, and a failure's message without swallowing it", async () => {
    await expect(recordCronRun(JOB, async () => ({ synced: 3, remaining: 0 }))).resolves.toEqual({ synced: 3, remaining: 0 });
    await expect(recordCronRun(JOB, async () => Promise.reject(new Error("ESI down")))).rejects.toThrow("ESI down");

    const [failed, ok] = (await cronStatus())[0].runs;
    expect(ok).toMatchObject({ job: JOB, ok: true, result: { synced: 3, remaining: 0 }, error: null });
    expect(ok.finishedAt).not.toBeNull();
    expect(failed).toMatchObject({ ok: false, error: "ESI down" });
  });

  it("forgets runs older than 90 days", async () => {
    await db.insert(cronRuns).values({ job: JOB, startedAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000), ok: true });
    await recordCronRun(JOB, async () => ({}));
    expect((await cronStatus())[0].runs).toHaveLength(1);
  });
});

describe("cronStatus", () => {
  it("lists every vercel.json job with its last success, and flags one the scheduler skipped", async () => {
    const now = new Date("2026-10-18T12:00:00Z");
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 60 * 60 * 1000);
    await db.insert(cronRuns).values([
      { job: JOB, startedAt: hoursAgo(50), finishedAt: hoursAgo(50), ok: true },
      { job: JOB, startedAt: hoursAgo(26), finishedAt: hoursAgo(26), ok: false, error: "boom" },
    ]);
    const [job] = await cronStatus(now);
    expect(job).toMatchObject({ path: JOB, name: "Wallet sync", schedule: "17 3 * * *", lastSuccess: hoursAgo(50), overdue: true });
    expect(job.runs.map((r) => r.ok)).toEqual([false, true]);
    expect(job.nextRun).toEqual(new Date("2026-10-19T03:17:00Z"));

    await db.insert(cronRuns).values({ job: JOB, startedAt: hoursAgo(9), ok: true });
    expect((await cronStatus(now))[0].overdue).toBe(false);
  });
});

describe("systemHealth", () => {
  it("reports the database, ESI and the site's counts", async () => {
    esi.mockResolvedValue({ players: 23456, server_version: "3000000", start_time: "2026-10-18T11:05:00Z" });
    const health = await systemHealth();
    expect(health.database).toMatchObject({ ok: true, migrationsApplied: health.migrationsInRepo });
    expect(health.esi).toMatchObject({ ok: true, players: 23456, serverVersion: "3000000", vip: false });
    expect(health.figures).toMatchObject({ profiles: expect.any(Number), tracking: expect.any(Number), journalLines: expect.any(Number) });
    expect(health.deployment.environment).toBe("local");
  });

  it("shows a dead dependency as failing instead of failing the panel", async () => {
    esi.mockRejectedValue(new Error("ESI GET /status failed (503): Service Unavailable"));
    const health = await systemHealth();
    expect(health.esi).toEqual({ ok: false, error: "ESI GET /status failed (503): Service Unavailable" });
    expect(health.database.ok).toBe(true);
  });
});
