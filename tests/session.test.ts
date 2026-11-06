import { describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { safeReturnTo } from "@/lib/auth/session";
import { GET } from "@/app/auth/callback/route";

const takeSsoFlow = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth/session", async (original) => ({ ...(await original<typeof import("@/lib/auth/session")>()), takeSsoFlow }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); }, unstable_rethrow: () => {} }));

describe("login return paths", () => {
  it.each(["//example.org", "/foo/..//example.org", "/%2e//example.org", "/a/%2e%2e//example.org", "/\\example.org", "/\t/example.org", "https://example.org", "javascript:alert(1)"])("rejects %s", (path) => {
    expect(safeReturnTo(path, "/characters")).toBe("/characters");
  });
  it("normalizes safe paths and preserves query and fragment", () => {
    expect(safeReturnTo("/foo/../fittings?q=Rifter#fit")).toBe("/fittings?q=Rifter#fit");
    expect(safeReturnTo(undefined)).toBe("/");
  });
  it("revalidates a pre-existing flow at the redirect sink", async () => {
    takeSsoFlow.mockResolvedValue({ state: "test", returnTo: "/foo/..//example.org" });
    await expect(GET(new NextRequest("http://localhost/auth/callback?state=test&error=access_denied")))
      .rejects.toThrow("REDIRECT:/?notice=sso-cancelled");
  });
});
