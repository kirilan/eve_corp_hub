import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { completeSignIn, loadViewer, setMainCharacter, type Viewer } from "@/lib/auth/accounts";
import {
  copyFitting,
  createFitting,
  deleteFitting,
  fittingByShareToken,
  FittingError,
  gameFittings,
  importGameFittings,
  listLibrary,
  listOwnFittings,
  sendManyToGame,
  sendToGame,
  setVisibility,
  updateFitting,
  viewableFitting,
} from "@/lib/fittings/store";
import { EsiError } from "@/lib/eve/esi";
import { BY_ID, BY_NAME, RIFTER_EFT } from "./fixtures/types";

vi.mock("@/lib/eve/types", () => ({
  typesByName: vi.fn(async (names: string[]) => new Map(names.flatMap((n) => (BY_NAME.has(n.toLowerCase()) ? [[n.toLowerCase(), BY_NAME.get(n.toLowerCase())!]] : [])))),
  typesById: vi.fn(async (ids: number[]) => new Map(ids.flatMap((id) => (BY_ID.has(id) ? [[id, BY_ID.get(id)!]] : [])))),
}));
vi.mock("@/lib/auth/tokens", () => ({ characterAccessToken: vi.fn(async () => "token") }));
const esi = vi.hoisted(() => vi.fn());
vi.mock("@/lib/eve/esi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/eve/esi")>()),
  esi,
  affiliations: vi.fn(async () => []),
}));

const CORP_A = 98000001;
const CORP_B = 98000002;

async function profile(characterId: number, corporationId: number, extra: number[] = []): Promise<Viewer> {
  const verified = (id: number) => ({ characterId: id, name: `Pilot ${id}`, ownerHash: `h${id}`, scopes: [], expiresAt: new Date() });
  const tokens = { access_token: "a", expires_in: 1199 };
  const { userId } = await completeSignIn({
    intent: "login",
    currentUserId: null,
    verified: verified(characterId),
    tokens,
    affiliation: { character_id: characterId, corporation_id: corporationId },
  });
  for (const alt of extra) {
    await completeSignIn({
      intent: "link",
      currentUserId: userId,
      verified: verified(alt),
      tokens,
      affiliation: { character_id: alt, corporation_id: CORP_B },
    });
  }
  return (await loadViewer(userId))!;
}

let owner: Viewer;
let corpmate: Viewer;
let outsider: Viewer;

beforeEach(async () => {
  await db.execute(sql`TRUNCATE users, characters, sessions, fittings CASCADE`);
  esi.mockReset();
  owner = await profile(1, CORP_A, [11]);
  corpmate = await profile(2, CORP_A);
  outsider = await profile(3, CORP_B);
});

describe("visibility", () => {
  it("keeps private fits to the owner", async () => {
    const { id } = await createFitting(owner, { eft: RIFTER_EFT });
    expect(await viewableFitting(owner, id)).toMatchObject({ name: "Fast tackle", shipName: null });
    expect(await viewableFitting(corpmate, id)).toBeNull();
    expect(await viewableFitting(null, id)).toBeNull();
  });

  it("shares corporation fits with the main's corporation, pinned at share time", async () => {
    const { id } = await createFitting(owner, { eft: RIFTER_EFT, visibility: "corporation" });
    expect(await viewableFitting(corpmate, id)).not.toBeNull();
    expect(await viewableFitting(outsider, id)).toBeNull();
    expect((await listLibrary(corpmate, "corporation")).map((fit) => fit.id)).toEqual([id]);
    expect(await listLibrary(outsider, "corporation")).toEqual([]);

    // The owner switching main to an alt in another corp re-targets neither the fit nor its edits...
    await setMainCharacter(owner.userId, 11);
    const switched = (await loadViewer(owner.userId))!;
    await updateFitting(switched, id, { eft: RIFTER_EFT, visibility: "corporation" });
    expect(await viewableFitting(corpmate, id)).not.toBeNull();
    // ...until the owner re-shares it, which uses the current main's corporation.
    await setVisibility(switched, id, "private");
    await setVisibility(switched, id, "corporation");
    expect(await viewableFitting(corpmate, id)).toBeNull();
    expect(await viewableFitting(outsider, id)).not.toBeNull();
  });

  it("opens link fits to anyone holding the token, and keeps the token across changes", async () => {
    const { id } = await createFitting(owner, { eft: RIFTER_EFT, visibility: "link" });
    const token = (await viewableFitting(owner, id))!.shareToken!;
    expect(await fittingByShareToken(null, token)).not.toBeNull();
    expect(await viewableFitting(outsider, id)).toBeNull();
    expect(await listLibrary(outsider, "public")).toEqual([]);

    await setVisibility(owner, id, "private");
    expect(await fittingByShareToken(null, token)).toBeNull();
    await setVisibility(owner, id, "link");
    expect((await viewableFitting(owner, id))!.shareToken).toBe(token);
  });

  it("lists public fits for everyone", async () => {
    const { id } = await createFitting(owner, { eft: RIFTER_EFT, visibility: "public" });
    expect((await listLibrary(null, "public")).map((fit) => fit.id)).toEqual([id]);
    expect((await listLibrary(outsider, "public"))[0]).toMatchObject({ ownerMainName: "Pilot 1" });
  });
});

describe("ownership", () => {
  it("lets only the owner change or delete a fit", async () => {
    const { id } = await createFitting(owner, { eft: RIFTER_EFT, visibility: "public" });
    await expect(setVisibility(corpmate, id, "private")).rejects.toBeInstanceOf(FittingError);
    await expect(deleteFitting(corpmate, id)).rejects.toBeInstanceOf(FittingError);
    await deleteFitting(owner, id);
    expect(await listOwnFittings(owner)).toEqual([]);
  });

  it("copies a visible fit as a private fit of the copier", async () => {
    const { id } = await createFitting(owner, { eft: RIFTER_EFT, visibility: "corporation" });
    const copy = await copyFitting(corpmate, id);
    expect(await viewableFitting(corpmate, copy)).toMatchObject({ visibility: "private", ownerId: corpmate.userId });
    await expect(copyFitting(outsider, id)).rejects.toBeInstanceOf(FittingError);
  });

  it("rejects input the game would refuse", async () => {
    await expect(createFitting(owner, { eft: RIFTER_EFT, name: "x".repeat(51) })).rejects.toThrow(/50 characters/);
    await expect(createFitting(owner, { eft: "[Rifter, x]\nNo Such Module\n" })).rejects.toThrow(/Unknown item/);
  });
});

describe("in-game fittings", () => {
  const gameFit = {
    fitting_id: 77,
    name: "Fast tackle",
    description: "",
    ship_type_id: 587,
    items: [
      { type_id: 2048, flag: "LoSlot3", quantity: 1 },
      { type_id: 2488, flag: "Invalid", quantity: 1 },
    ],
  };

  it("imports chosen fits once and recognises them afterwards", async () => {
    esi.mockResolvedValue([gameFit]);
    expect(await importGameFittings(owner, 1, [77])).toBe(1);
    const [listed] = await gameFittings(owner, 1);
    expect(listed).toMatchObject({ shipName: "Rifter", alreadySaved: false });
    // "Invalid" entries are dropped on import, so the stored fit differs from the raw game one...
    const [stored] = await listOwnFittings(owner);
    expect(stored.items).toEqual([{ type_id: 2048, flag: "LoSlot3", quantity: 1 }]);
    // ...and a clean game fit with the same contents counts as already saved.
    esi.mockResolvedValue([{ ...gameFit, items: [{ type_id: 2048, flag: "LoSlot0", quantity: 1 }] }]);
    expect((await gameFittings(owner, 1))[0].alreadySaved).toBe(true);
    expect(await importGameFittings(owner, 1, [77])).toBe(0);
  });

  it("sends a visible fit to the character in ESI's shape", async () => {
    const { id } = await createFitting(owner, { eft: RIFTER_EFT, visibility: "corporation" });
    esi.mockResolvedValue({ fitting_id: 5 });
    await sendToGame(corpmate, id, 2);
    const [path, init] = esi.mock.calls[0];
    expect(path).toBe("/characters/2/fittings");
    expect(init).toMatchObject({ method: "POST", token: "token", body: { name: "Fast tackle", ship_type_id: 587 } });
    expect(init.body.items).toHaveLength(10);
    await expect(sendToGame(outsider, id, 3)).rejects.toBeInstanceOf(FittingError);
  });
});

describe("bulk send", () => {
  const second = "[Rifter, Brawler]\nDamage Control II\n";

  it("skips fits already on the character, sends the rest, and keeps going past a failure", async () => {
    const a = await createFitting(owner, { eft: RIFTER_EFT });
    const b = await createFitting(owner, { eft: second });
    const c = await createFitting(owner, { eft: "[Rifter, Webber]\nStasis Webifier II\n" });
    // In game already: fit b's contents, under other slot numbers.
    esi.mockImplementation(async (_path: string, init?: { method?: string; body?: { name: string } }) => {
      if (!init?.method) return [{ fitting_id: 1, name: "old", description: "", ship_type_id: 587, items: [{ type_id: 2048, flag: "LoSlot4", quantity: 1 }] }];
      if (init.body?.name === "Webber") throw new EsiError("too many fittings", 400);
      return { fitting_id: 9 };
    });

    const results = await sendManyToGame(owner, [a.id, b.id, c.id, a.id], 1);
    expect(results.map((r) => [r.name, r.status])).toEqual([
      ["Fast tackle", "sent"],
      ["Brawler", "skipped"],
      ["Webber", "failed"],
    ]);
  });

  it("stops at the first rejected token instead of failing every fit", async () => {
    const a = await createFitting(owner, { eft: RIFTER_EFT });
    const b = await createFitting(owner, { eft: second });
    esi.mockImplementation(async (_path: string, init?: { method?: string }) => {
      if (!init?.method) return [];
      throw new EsiError("token not valid", 403);
    });
    expect(await sendManyToGame(owner, [a.id, b.id], 1)).toHaveLength(1);
  });

  it("only sends fits the viewer can see", async () => {
    const hidden = await createFitting(owner, { eft: RIFTER_EFT });
    esi.mockResolvedValue([]);
    expect(await sendManyToGame(outsider, [hidden.id], 3)).toEqual([]);
    expect(esi.mock.calls.every(([, init]) => !init?.method)).toBe(true);
  });
});
