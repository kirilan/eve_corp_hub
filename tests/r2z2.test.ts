import { afterEach, describe, expect, it, vi } from "vitest";
import { r2z2Day, r2z2Totals } from "@/lib/pvp/comps/r2z2";
import { ZkillError } from "@/lib/pvp/zkill";

const fetchMock = vi.fn<typeof fetch>();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => fetchMock.mockReset());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("R2Z2", () => {
  it("reads day counts by ISO day, identifying itself", async () => {
    fetchMock.mockResolvedValue(json({ "20261124": 12964, "20261125": 4000, junk: "x" }));
    expect(await r2z2Totals()).toEqual(
      new Map([
        ["2026-11-24", 12964],
        ["2026-11-25", 4000],
      ]),
    );
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://r2z2.zkillboard.com/history/totals.json");
    expect(new Headers(init?.headers).get("User-Agent")).toMatch(/^Drydock \(http:\/\/localhost:3000; tests\)$/);
  });

  it("reads a day's killmails from its file, and null when there is none", async () => {
    const killmail = { killmail_id: 5, killmail_time: "2026-11-24T00:00:07Z", solar_system_id: 1, victim: { ship_type_id: 587 }, attackers: [] };
    fetchMock.mockResolvedValueOnce(json({ "5": killmail }));
    expect(await r2z2Day("2026-11-24")).toEqual([killmail]);
    expect(fetchMock.mock.calls[0][0]).toBe("https://r2z2.zkillboard.com/history/raw/20261124.json");

    fetchMock.mockResolvedValueOnce(new Response("not found", { status: 404 }));
    expect(await r2z2Day("2026-11-26")).toBeNull();
  });

  it("fails on errors and on answers that are not killmails", async () => {
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 503 }));
    await expect(r2z2Day("2026-11-24")).rejects.toThrow(new ZkillError("R2Z2 day 2026-11-24 failed (503)"));
    fetchMock.mockResolvedValueOnce(json([1, 2]));
    await expect(r2z2Day("2026-11-24")).rejects.toThrow("not an object of killmails");
    fetchMock.mockResolvedValueOnce(json(null, 500));
    await expect(r2z2Totals()).rejects.toThrow("totals.json failed (500)");
  });
});
