import { eq, sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { characters, users } from "@/db/schema";
import {
  completeSignIn,
  LinkConflictError,
  loadViewer,
  setMainCharacter,
  unlinkCharacter,
} from "@/lib/auth/accounts";
import { decrypt } from "@/lib/crypto";
import type { VerifiedCharacter } from "@/lib/eve/sso";

vi.mock("@/lib/eve/sso", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/eve/sso")>()),
  revokeRefreshToken: vi.fn(async () => undefined),
}));

const FITTING_SCOPES = ["esi-fittings.read_fittings.v1", "esi-fittings.write_fittings.v1"];

function character(id: number, overrides: Partial<VerifiedCharacter> = {}): VerifiedCharacter {
  return {
    characterId: id,
    name: `Pilot ${id}`,
    ownerHash: `owner-${id}`,
    scopes: [],
    expiresAt: new Date(Date.now() + 20 * 60_000),
    ...overrides,
  };
}

const tokens = { access_token: "access", refresh_token: "refresh", expires_in: 1199 };
const corp = (characterId: number, corporationId: number) => ({ character_id: characterId, corporation_id: corporationId });

function signIn(verified: VerifiedCharacter, intent: "login" | "link" = "login", currentUserId: string | null = null) {
  return completeSignIn({ intent, currentUserId, verified, tokens, affiliation: corp(verified.characterId, 98000001) });
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE users, characters, sessions, fittings, doctrines, audit_log CASCADE`);
});

describe("completeSignIn", () => {
  it("creates a profile with the first character as main", async () => {
    const result = await signIn(character(1));
    expect(result.outcome).toBe("created");
    const viewer = await loadViewer(result.userId);
    expect(viewer?.main).toMatchObject({ id: 1, name: "Pilot 1", corporationId: 98000001 });
  });

  it("signs an existing character back into its profile", async () => {
    const first = await signIn(character(1));
    const again = await signIn(character(1));
    expect(again).toMatchObject({ outcome: "signed-in", userId: first.userId });
    expect(await db.$count(users)).toBe(1);
  });

  it("links an alt from another account without changing the main", async () => {
    const main = await signIn(character(1));
    const alt = await signIn(character(2, { ownerHash: "other-account" }), "link", main.userId);
    expect(alt).toMatchObject({ outcome: "linked", userId: main.userId });
    expect((await loadViewer(main.userId))?.main?.id).toBe(1);
    // Logging in with the alt later lands in the same profile.
    expect((await signIn(character(2, { ownerHash: "other-account" }))).userId).toBe(main.userId);
  });

  it("refuses to pull a character out of someone else's profile", async () => {
    await signIn(character(1));
    const other = await signIn(character(2));
    await expect(signIn(character(1), "link", other.userId)).rejects.toBeInstanceOf(LinkConflictError);
  });

  it("moves a transferred character out of its old profile and hands main to the next character", async () => {
    const seller = await signIn(character(1));
    await signIn(character(2), "link", seller.userId);
    const buyer = await signIn(character(1, { ownerHash: "new-owner" }));

    expect(buyer.outcome).toBe("created");
    expect(buyer.userId).not.toBe(seller.userId);
    expect((await loadViewer(seller.userId))?.main?.id).toBe(2);
    expect((await loadViewer(buyer.userId))?.main?.id).toBe(1);
  });

  it("does not let a scope-less sign-in erase consent granted earlier", async () => {
    const result = await signIn(character(1, { scopes: FITTING_SCOPES }));
    await signIn(character(1));
    const [row] = await db.select().from(characters).where(eq(characters.id, 1));
    expect(row.scopes).toEqual(FITTING_SCOPES);
    expect(decrypt(row.refreshTokenEnc!)).toBe("refresh");
    expect(result.userId).toBe(row.userId);
  });
});

describe("main and unlink", () => {
  it("switches main only to an own character", async () => {
    const mine = await signIn(character(1));
    await signIn(character(2), "link", mine.userId);
    await signIn(character(3));

    await expect(setMainCharacter(mine.userId, 3)).rejects.toThrow(/not linked/);
    await setMainCharacter(mine.userId, 2);
    expect((await loadViewer(mine.userId))?.main?.id).toBe(2);
  });

  it("will not unlink the main, but unlinks an alt", async () => {
    const mine = await signIn(character(1));
    await signIn(character(2, { scopes: FITTING_SCOPES }), "link", mine.userId);

    await expect(unlinkCharacter(mine.userId, 1)).rejects.toThrow(/main/);
    await unlinkCharacter(mine.userId, 2);
    expect(await db.$count(characters, eq(characters.userId, mine.userId))).toBe(1);
  });
});
