import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { db } from "@/db";
import { walletEntries, walletSyncs } from "@/db/schema";
import { completeSignIn, revokeCharacterScopes, unlinkCharacter } from "@/lib/auth/accounts";
import { FEATURE_SCOPES } from "@/lib/eve/sso";
import { deleteIncomeHistory, syncCharacterIncome, syncStaleIncome, type JournalEntry } from "@/lib/income/sync";

const esiPages = vi.hoisted(() => vi.fn());
// Market transactions are read beside the journal; these tests are about the journal, so there are none.
const esi = vi.hoisted(() => vi.fn(async () => []));
vi.mock("@/lib/eve/esi", async (original) => ({ ...(await original<typeof import("@/lib/eve/esi")>()), esiPages, esi }));
vi.mock("@/lib/eve/sso", async (original) => ({ ...(await original<typeof import("@/lib/eve/sso")>()), revokeRefreshToken: vi.fn(async () => undefined) }));

async function sign(id: number, ownerHash = "owner", userId: string | null = null, scopes: string[] = [...FEATURE_SCOPES.wallet]) {
  return completeSignIn({
    intent: userId ? "link" : "login", currentUserId: userId,
    verified: { characterId: id, name: `Pilot ${id}`, ownerHash, scopes, expiresAt: new Date(Date.now() + 600_000) },
    tokens: { access_token: "test-access", refresh_token: "test-refresh", expires_in: 600 }, affiliation: null,
  });
}
const rows: JournalEntry[] = [{ id: 1, date: new Date().toISOString(), ref_type: "bounty_prizes", amount: 987654 }];
function holdFetch() {
  const started = Promise.withResolvers<void>();
  const response = Promise.withResolvers<JournalEntry[]>();
  esiPages.mockImplementationOnce(() => { started.resolve(); return response.promise; });
  return { started: started.promise, response };
}
beforeEach(async () => {
  await db.execute(sql`TRUNCATE users CASCADE`);
  esiPages.mockReset();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

it.each(["success", "failure"])("discards an old owner's late %s after transfer", async (outcome) => {
  const oldOwner = await sign(1);
  const held = holdFetch();
  const pending = syncCharacterIncome(oldOwner.userId, 1);
  await held.started;
  const buyer = await sign(1, "new-owner", null, []);
  expect(buyer.userId).not.toBe(oldOwner.userId);
  if (outcome === "success") held.response.resolve(rows);
  else held.response.reject(new Error("old owner's failure"));
  await pending;
  expect(await db.$count(walletEntries)).toBe(0);
  expect(await db.$count(walletSyncs)).toBe(0);
});

it.each(["revoke", "delete", "unlink"])("does not restore history after %s, even if the same character is granted access again", async (operation) => {
  const owner = await sign(1);
  await sign(2, "owner", owner.userId);
  const held = holdFetch();
  const pending = syncCharacterIncome(owner.userId, 2);
  await held.started;
  if (operation === "revoke") await revokeCharacterScopes(owner.userId, 2);
  if (operation === "delete") await deleteIncomeHistory(owner.userId, 2);
  if (operation === "unlink") await unlinkCharacter(owner.userId, 2);
  await sign(2, "owner", owner.userId);
  held.response.resolve(rows);
  await pending;
  expect(await db.$count(walletEntries)).toBe(0);
});

it("claims a stale wallet once across concurrent direct and page syncs", async () => {
  const owner = await sign(1);
  const held = holdFetch();
  const pending = syncCharacterIncome(owner.userId, 1);
  await held.started;
  await Promise.all([syncStaleIncome(owner.userId), syncCharacterIncome(owner.userId, 1)]);
  expect(esiPages).toHaveBeenCalledTimes(1);
  held.response.resolve(rows);
  await pending;
  await syncStaleIncome(owner.userId);
  expect(esiPages).toHaveBeenCalledTimes(1);
  expect(await db.$count(walletEntries)).toBe(1);
});

it.each(["success", "failure"])("ignores an expired worker's %s after a newer lease finishes", async (outcome) => {
  const owner = await sign(1);
  const held = holdFetch();
  const pending = syncCharacterIncome(owner.userId, 1);
  await held.started;
  await db.update(walletSyncs).set({ leaseExpiresAt: new Date(0) }).where(eq(walletSyncs.characterId, 1));
  esiPages.mockResolvedValueOnce([{ ...rows[0], id: 2, amount: 10 }]);
  await syncCharacterIncome(owner.userId, 1);
  if (outcome === "success") held.response.resolve(rows);
  else held.response.reject(new Error("expired request"));
  await pending;
  expect(await db.select({ id: walletEntries.journalId }).from(walletEntries)).toEqual([{ id: 2 }]);
  expect((await db.select().from(walletSyncs))[0]).toMatchObject({ error: null, leaseId: null });
});

it("bounds page-triggered sync concurrency to four characters", async () => {
  const owner = await sign(1);
  for (let id = 2; id <= 8; id++) await sign(id, "owner", owner.userId);
  const firstFour = Promise.withResolvers<void>();
  const release = Promise.withResolvers<JournalEntry[]>();
  esiPages.mockImplementation(() => {
    if (esiPages.mock.calls.length === 4) firstFour.resolve();
    return release.promise;
  });
  const pending = syncStaleIncome(owner.userId);
  await firstFour.promise;
  expect(esiPages).toHaveBeenCalledTimes(4);
  release.resolve([]);
  await pending;
  expect(esiPages).toHaveBeenCalledTimes(8);
});

it("does not claim or fetch when the caller's budget is exhausted", async () => {
  const owner = await sign(1);
  await syncCharacterIncome(owner.userId, 1, AbortSignal.abort());
  expect(esiPages).not.toHaveBeenCalled();
  expect(await db.$count(walletSyncs)).toBe(0);
});

it("keeps the last successful wallet state when pagination is incomplete", async () => {
  const owner = await sign(1);
  esiPages.mockResolvedValueOnce(rows);
  await syncCharacterIncome(owner.userId, 1);
  const [previous] = await db.select().from(walletSyncs);
  await db.update(walletSyncs).set({ attemptedAt: new Date(0) });
  const actual = await vi.importActual<typeof import("@/lib/eve/esi")>("@/lib/eve/esi");
  esiPages.mockImplementationOnce(actual.esiPages);
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([{ ...rows[0], id: 2 }]), { headers: { "X-Pages": "51" } })));
  try {
    await syncCharacterIncome(owner.userId, 1);
    expect(await db.$count(walletEntries)).toBe(1);
    const [current] = await db.select().from(walletSyncs);
    expect(current.syncedAt).toEqual(previous.syncedAt);
    expect(current.historyFrom).toEqual(previous.historyFrom);
    expect(current.error).toMatch(/incomplete/);
  } finally {
    vi.unstubAllGlobals();
  }
});
