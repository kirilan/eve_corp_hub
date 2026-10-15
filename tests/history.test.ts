import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db } from "@/db";
import { readAudit } from "@/lib/audit";
import { completeSignIn, loadViewer, type Viewer } from "@/lib/auth/accounts";
import { setSuperUser } from "@/lib/auth/super-users";
import {
  addFitToDoctrine,
  createDoctrine,
  deleteDoctrine,
  doctrineWithFits,
  listDoctrines,
  removeFitFromDoctrine,
} from "@/lib/doctrines";
import { createFitting, deleteFitting, fittingHistory, FittingError, restoreVersion, setVisibility, updateFitting } from "@/lib/fittings/store";
import { BY_NAME, RIFTER_EFT } from "./fixtures/types";

vi.mock("@/lib/eve/types", () => ({
  typesByName: vi.fn(async (names: string[]) => new Map(names.flatMap((n) => (BY_NAME.has(n.toLowerCase()) ? [[n.toLowerCase(), BY_NAME.get(n.toLowerCase())!]] : [])))),
  typesById: vi.fn(async () => new Map()),
}));

const CORP_A = 98000001;
const CORP_B = 98000002;
const BRAWLER = "[Rifter, Fast tackle]\nDamage Control II\n";

async function profile(characterId: number, corporationId: number, superUser = false): Promise<Viewer> {
  const { userId } = await completeSignIn({
    intent: "login",
    currentUserId: null,
    verified: { characterId, name: `Pilot ${characterId}`, ownerHash: `h${characterId}`, scopes: [], expiresAt: new Date() },
    tokens: { access_token: "a", expires_in: 1199 },
    affiliation: { character_id: characterId, corporation_id: corporationId },
  });
  if (superUser) await db.execute(sql`UPDATE users SET is_super_user = true WHERE id = ${userId}`);
  return (await loadViewer(userId))!;
}

let owner: Viewer;
let member: Viewer;
let boss: Viewer; // super user in CORP_A
let foreignBoss: Viewer; // super user in CORP_B

beforeEach(async () => {
  await db.execute(sql`TRUNCATE users, characters, sessions, fittings, doctrines, audit_log CASCADE`);
  owner = await profile(1, CORP_A);
  member = await profile(2, CORP_A);
  boss = await profile(3, CORP_A, true);
  foreignBoss = await profile(4, CORP_B, true);
});

describe("version history", () => {
  it("numbers every content change, skips no-op saves, and restores as a new version", async () => {
    const { id } = await createFitting(owner, { eft: RIFTER_EFT });
    await updateFitting(owner, id, { eft: BRAWLER });
    await updateFitting(owner, id, { eft: BRAWLER }); // same contents: no new version
    await setVisibility(owner, id, "corporation"); // sharing is not a content version

    const history = await fittingHistory(owner, id);
    expect(history!.versions.map((v) => [v.version, v.source, v.editorName])).toEqual([
      [2, "edited", "Pilot 1"],
      [1, "created", "Pilot 1"],
    ]);

    expect(await restoreVersion(owner, id, 1)).toBe(3);
    const restored = (await fittingHistory(owner, id))!;
    expect(restored.fit.items).toEqual(restored.versions.find((v) => v.version === 1)!.items);
    await expect(restoreVersion(owner, id, 1)).rejects.toThrow(/already has those contents/);
  });

  it("shows history to whoever can see the fit, and lets only the owner restore", async () => {
    const { id } = await createFitting(owner, { eft: RIFTER_EFT, visibility: "corporation" });
    await updateFitting(owner, id, { eft: BRAWLER, visibility: "corporation" });
    expect((await fittingHistory(member, id))!.versions).toHaveLength(2);
    expect(await fittingHistory(foreignBoss, id)).toBeNull();
    await expect(restoreVersion(member, id, 1)).rejects.toBeInstanceOf(FittingError);
  });
});

describe("audit log", () => {
  it("records shared-fit changes for the corporation's super users and keeps private work out", async () => {
    const { id } = await createFitting(owner, { eft: RIFTER_EFT }); // private: not audited
    await updateFitting(owner, id, { eft: BRAWLER });
    await setVisibility(owner, id, "corporation");
    await updateFitting(owner, id, { eft: RIFTER_EFT, visibility: "corporation" });
    await deleteFitting(boss, id); // moderation

    const entries = await readAudit(boss);
    expect(entries.map((e) => [e.action, e.actorName])).toEqual([
      ["fit.deleted", "Pilot 3"],
      ["fit.edited", "Pilot 1"],
      ["fit.shared", "Pilot 1"],
    ]);
    expect(entries[0].details).toMatchObject({ moderated: true });
    expect(entries[2].details).toEqual({ from: "private", to: "corporation" });

    expect(await readAudit(foreignBoss)).toEqual([]);
    expect(await readAudit(member)).toEqual([]);
  });

  it("files public-fit and super user changes site-wide", async () => {
    await createFitting(owner, { eft: RIFTER_EFT, visibility: "public" });
    await setSuperUser(boss, member.userId, true);
    expect((await readAudit(foreignBoss)).map((e) => e.action)).toEqual(["user.super_granted", "fit.created"]);
  });
});

describe("super users", () => {
  it("can be granted only by super users, never to themselves", async () => {
    await expect(setSuperUser(member, owner.userId, true)).rejects.toThrow(/Only super users/);
    await expect(setSuperUser(boss, boss.userId, false)).rejects.toThrow(/another super user/);
    await setSuperUser(boss, member.userId, true);
    expect((await loadViewer(member.userId))!.isSuperUser).toBe(true);
  });
});

describe("doctrines", () => {
  it("are managed by the corporation's super users and seen by its members", async () => {
    await expect(createDoctrine(member, { name: "Armor Rifters" })).rejects.toThrow(/super users/);
    const id = await createDoctrine(boss, { name: "Armor Rifters" });
    expect((await listDoctrines(member)).map((d) => d.name)).toEqual(["Armor Rifters"]);
    expect(await listDoctrines(foreignBoss)).toEqual([]);
    expect(await doctrineWithFits(foreignBoss, id)).toBeNull();
    await expect(addFitToDoctrine(foreignBoss, id, "00000000-0000-0000-0000-000000000000")).rejects.toThrow(/not found/);
  });

  it("only holds fits the whole corporation can see, and hides ones made private later", async () => {
    const doctrine = await createDoctrine(boss, { name: "Tackle" });
    const priv = await createFitting(boss, { eft: RIFTER_EFT });
    await expect(addFitToDoctrine(boss, doctrine, priv.id)).rejects.toThrow(/shared with the corporation/);

    const shared = await createFitting(owner, { eft: RIFTER_EFT, visibility: "corporation" });
    await addFitToDoctrine(boss, doctrine, shared.id);
    await addFitToDoctrine(boss, doctrine, shared.id); // idempotent, audited once
    expect((await doctrineWithFits(member, doctrine))!.fits.map((f) => f.id)).toEqual([shared.id]);

    await setVisibility(owner, shared.id, "private");
    expect(await doctrineWithFits(member, doctrine)).toMatchObject({ fits: [], hidden: 1 });

    await removeFitFromDoctrine(boss, doctrine, shared.id);
    await deleteDoctrine(boss, doctrine);
    const actions = (await readAudit(boss)).filter((e) => e.subjectType === "doctrine").map((e) => e.action);
    expect(actions).toEqual(["doctrine.deleted", "doctrine.fit_removed", "doctrine.fit_added", "doctrine.created"]);
  });
});
