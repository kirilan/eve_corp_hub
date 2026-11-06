import { afterEach, expect, it, vi } from "vitest";
import { esi, esiPages } from "@/lib/eve/esi";
import { refreshAccessToken } from "@/lib/eve/sso";
import { OPERATION_TIMEOUT_MS, REQUEST_TIMEOUT_MS } from "@/lib/eve/deadline";

const response = (page: number, pages = 1) => new Response(JSON.stringify([{ page }]), { headers: { "X-Pages": String(pages) } });
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("reads all pages in order, within the concurrency bound", async () => {
  let active = 0;
  let peak = 0;
  const fetcher = vi.fn(async (url: string) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return response(Number(new URL(url).searchParams.get("page")), 12);
  });
  vi.stubGlobal("fetch", fetcher);
  expect(await esiPages("/test")).toEqual(Array.from({ length: 12 }, (_, i) => ({ page: i + 1 })));
  expect(peak).toBeLessThanOrEqual(8);
});

it("rejects an oversized journal before downloading a partial snapshot", async () => {
  const fetcher = vi.fn(async () => response(1, 51));
  vi.stubGlobal("fetch", fetcher);
  await expect(esiPages("/journal")).rejects.toMatchObject({ status: 502 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("supports an explicit larger cap and rejects changes in page count", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => response(Number(new URL(url).searchParams.get("page")), 51)));
  expect(await esiPages("/market", { maxPages: 200 })).toHaveLength(51);
  vi.stubGlobal("fetch", vi.fn(async (url: string) => response(1, new URL(url).searchParams.get("page") === "1" ? 3 : 2)));
  await expect(esiPages("/market")).rejects.toThrow(/pagination changed/);
});

function hangingFetch() {
  vi.stubGlobal("fetch", vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
    if (init.signal!.aborted) reject(init.signal!.reason);
    else init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  })));
}

it.each(["ESI", "SSO"])("aborts a stalled %s request at its own deadline", async (kind) => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => nativeTimeout(5));
  hangingFetch();
  const pending = kind === "ESI" ? esi("/test") : refreshAccessToken("test-refresh");
  await expect(pending).rejects.toThrow();
  expect(timeout).toHaveBeenCalledWith(REQUEST_TIMEOUT_MS);
});

it("propagates cancellation through a paginated operation", async () => {
  hangingFetch();
  const parent = new AbortController();
  const pending = esiPages("/journal", { signal: parent.signal });
  parent.abort();
  await expect(pending).rejects.toMatchObject({ status: 504 });
});

it("applies one total deadline across pages", async () => {
  const nativeTimeout = AbortSignal.timeout.bind(AbortSignal);
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => nativeTimeout(ms === OPERATION_TIMEOUT_MS ? 5 : 1000));
  hangingFetch();
  await expect(esiPages("/journal")).rejects.toMatchObject({ status: 504 });
});
