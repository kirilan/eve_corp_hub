import "server-only";
import { and, desc, eq, ilike, max, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db, type Tx } from "@/db";
import { characters, eveTypes, fittings, fittingVersions, users, type Fitting, type FittingItem } from "@/db/schema";
import { audit, fitAuditScope } from "@/lib/audit";
import type { Viewer } from "@/lib/auth/accounts";
import { characterAccessToken } from "@/lib/auth/tokens";
import { randomToken } from "@/lib/crypto";
import { esi, EsiError } from "@/lib/eve/esi";
import { typesById, typesByName } from "@/lib/eve/types";
import { canDeleteFitting, canEditFitting, canShareWithCorporation, canViewFitting, corporationOf } from "@/lib/permissions";
import { buildFit, EftError, fitSignature, namesIn, parseEft } from "./eft";

/** A problem worth showing the user as-is (bad input, missing permission), as opposed to a bug. */
export class FittingError extends Error {}

export const VISIBILITIES = ["private", "corporation", "link", "public"] as const;
export type Visibility = (typeof VISIBILITIES)[number];

// ESI's own limits for POST /characters/{id}/fittings, enforced up front so every stored fit can go to the game.
export const fitInput = z.object({
  eft: z.string().trim().min(1, "Paste a fit in EFT format."),
  name: z.string().trim().max(50, "Names are limited to 50 characters in game.").optional(),
  description: z.string().trim().max(500, "Descriptions are limited to 500 characters in game.").default(""),
  visibility: z.enum(VISIBILITIES).default("private"),
});
export type FitInput = z.input<typeof fitInput>;

function sharing(viewer: Viewer, visibility: Visibility, current?: Pick<Fitting, "visibility" | "corporationId" | "shareToken">) {
  // A fit already shared with a corporation stays with that corporation through edits; only
  // re-sharing (via another visibility) re-targets it to the owner's current main corporation.
  const keepCorporation = visibility === "corporation" && current?.visibility === "corporation" ? current.corporationId : null;
  if (visibility === "corporation" && keepCorporation === null && !canShareWithCorporation(viewer)) {
    throw new FittingError("Your main character has no known corporation to share with.");
  }
  return {
    visibility,
    corporationId: visibility === "corporation" ? (keepCorporation ?? corporationOf(viewer)) : null,
    // Kept once minted, so a fit switched away from "link" and back keeps working at the same URL.
    shareToken: current?.shareToken ?? (visibility === "link" ? randomToken(18) : null),
  };
}

async function fitFromEft(eft: string, nameOverride: string | undefined) {
  try {
    const parsed = parseEft(eft);
    const built = buildFit(parsed, await typesByName(namesIn(parsed)));
    const name = (nameOverride || parsed.fitName || "Unnamed fit").slice(0, 50);
    return { ...built, name };
  } catch (error) {
    if (error instanceof EftError) throw new FittingError(error.message);
    throw error;
  }
}

type Contents = Pick<Fitting, "name" | "description" | "shipTypeId" | "items">;
type VersionSource = "created" | "edited" | "imported" | "copied" | "restored";

/** Appends the next version of a fit's contents; the caller holds the fit row (or just created it). */
async function writeVersion(tx: Tx, viewer: Viewer, fittingId: string, contents: Contents, source: VersionSource) {
  const [{ latest }] = await tx
    .select({ latest: max(fittingVersions.version) })
    .from(fittingVersions)
    .where(eq(fittingVersions.fittingId, fittingId));
  const version = (latest ?? 0) + 1;
  await tx.insert(fittingVersions).values({
    fittingId,
    version,
    ...contents,
    source,
    editorId: viewer.userId,
    editorName: viewer.main?.name ?? null,
  });
  return version;
}

async function insertFitting(
  tx: Tx,
  viewer: Viewer,
  contents: Contents,
  share: ReturnType<typeof sharing> | null,
  source: VersionSource,
): Promise<string> {
  const [row] = await tx
    .insert(fittings)
    .values({ ownerId: viewer.userId, ...contents, ...(share ?? {}) })
    .returning({ id: fittings.id, visibility: fittings.visibility, corporationId: fittings.corporationId });
  await writeVersion(tx, viewer, row.id, contents, source);
  const scope = fitAuditScope(row);
  if (scope) {
    await audit(tx, viewer, { action: "fit.created", subjectType: "fitting", subjectId: row.id, subjectName: contents.name, ...scope, details: { visibility: row.visibility } });
  }
  return row.id;
}

export async function createFitting(viewer: Viewer, input: FitInput): Promise<{ id: string; warnings: string[] }> {
  const data = fitInput.parse(input);
  const fit = await fitFromEft(data.eft, data.name);
  const contents = { name: fit.name, description: data.description, shipTypeId: fit.shipTypeId, items: fit.items };
  const id = await db.transaction((tx) => insertFitting(tx, viewer, contents, sharing(viewer, data.visibility), "created"));
  return { id, warnings: fit.warnings };
}

/** Locks and returns a fit the viewer may edit (owner only). */
async function lockOwnFitting(tx: Tx, viewer: Viewer, id: string): Promise<Fitting> {
  if (!z.uuid().safeParse(id).success) throw new FittingError("Fit not found.");
  const [fit] = await tx.select().from(fittings).where(eq(fittings.id, id)).for("update");
  if (!fit || !canEditFitting(viewer, fit)) throw new FittingError("Fit not found.");
  return fit;
}

// Field by field: jsonb hands objects back with its own key order, so JSON.stringify would differ.
const itemKey = (item: FittingItem) => `${item.flag}:${item.type_id}:${item.quantity}`;

function sameContents(a: Contents, b: Contents): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.shipTypeId === b.shipTypeId &&
    a.items.length === b.items.length &&
    a.items.every((item, index) => itemKey(item) === itemKey(b.items[index]))
  );
}

/** Audits a visibility change, filed where the fit is (or was) shared; private-to-private is not audited. */
async function auditSharing(tx: Tx, viewer: Viewer, before: Fitting, after: { visibility: Visibility; corporationId: number | null }) {
  if (before.visibility === after.visibility && before.corporationId === after.corporationId) return;
  const scope = fitAuditScope(after.visibility === "private" ? before : after);
  if (!scope) return;
  await audit(tx, viewer, {
    action: "fit.shared",
    subjectType: "fitting",
    subjectId: before.id,
    subjectName: before.name,
    ...scope,
    details: { from: before.visibility, to: after.visibility },
  });
}

export async function updateFitting(viewer: Viewer, id: string, input: FitInput): Promise<{ warnings: string[] }> {
  const data = fitInput.parse(input);
  const fit = await fitFromEft(data.eft, data.name);
  const contents = { name: fit.name, description: data.description, shipTypeId: fit.shipTypeId, items: fit.items };
  await db.transaction(async (tx) => {
    const current = await lockOwnFitting(tx, viewer, id);
    const share = sharing(viewer, data.visibility, current);
    const changed = !sameContents(current, contents);
    await tx
      .update(fittings)
      .set({ ...contents, ...share, ...(changed && { updatedAt: new Date() }) })
      .where(eq(fittings.id, id));
    if (changed) {
      const version = await writeVersion(tx, viewer, id, contents, "edited");
      const scope = fitAuditScope(share.visibility === "private" ? current : share);
      if (scope) {
        await audit(tx, viewer, { action: "fit.edited", subjectType: "fitting", subjectId: id, subjectName: contents.name, ...scope, details: { version } });
      }
    }
    await auditSharing(tx, viewer, current, share);
  });
  return { warnings: fit.warnings };
}

export async function setVisibility(viewer: Viewer, id: string, visibility: Visibility): Promise<void> {
  await db.transaction(async (tx) => {
    const current = await lockOwnFitting(tx, viewer, id);
    const share = sharing(viewer, visibility, current);
    await tx.update(fittings).set(share).where(eq(fittings.id, id));
    await auditSharing(tx, viewer, current, share);
  });
}

export async function deleteFitting(viewer: Viewer, id: string): Promise<void> {
  if (!z.uuid().safeParse(id).success) throw new FittingError("Fit not found.");
  await db.transaction(async (tx) => {
    const [fit] = await tx.select().from(fittings).where(eq(fittings.id, id)).for("update");
    if (!fit) throw new FittingError("Fit not found.");
    const [owner] = await tx
      .select({ corporationId: characters.corporationId })
      .from(users)
      .innerJoin(characters, eq(characters.id, users.mainCharacterId))
      .where(eq(users.id, fit.ownerId));
    if (!canDeleteFitting(viewer, { ...fit, ownerCorporationId: owner?.corporationId ?? null })) throw new FittingError("Fit not found.");
    await tx.delete(fittings).where(eq(fittings.id, id));
    const scope = fitAuditScope(fit);
    if (scope) {
      await audit(tx, viewer, {
        action: "fit.deleted",
        subjectType: "fitting",
        subjectId: id,
        subjectName: fit.name,
        ...scope,
        // A super user taking down someone else's fit is moderation; say so in the record.
        details: { moderated: fit.ownerId !== viewer.userId, visibility: fit.visibility },
      });
    }
  });
}

/** Makes an earlier version the current contents again, as a new version (history is never rewritten). */
export async function restoreVersion(viewer: Viewer, id: string, version: number): Promise<number> {
  return db.transaction(async (tx) => {
    const current = await lockOwnFitting(tx, viewer, id);
    const [old] = await tx
      .select()
      .from(fittingVersions)
      .where(and(eq(fittingVersions.fittingId, id), eq(fittingVersions.version, version)));
    if (!old) throw new FittingError("That version does not exist.");
    const contents = { name: old.name, description: old.description, shipTypeId: old.shipTypeId, items: old.items };
    if (sameContents(current, contents)) throw new FittingError("The fit already has those contents.");
    await tx.update(fittings).set({ ...contents, updatedAt: new Date() }).where(eq(fittings.id, id));
    const created = await writeVersion(tx, viewer, id, contents, "restored");
    const scope = fitAuditScope(current);
    if (scope) {
      await audit(tx, viewer, {
        action: "fit.restored",
        subjectType: "fitting",
        subjectId: id,
        subjectName: contents.name,
        ...scope,
        details: { restoredFrom: version, version: created },
      });
    }
    return created;
  });
}

/** A fit's versions, newest first, for anyone who may see the fit itself. */
export async function fittingHistory(viewer: Viewer | null, id: string, shareToken?: string) {
  const fit = await viewableFitting(viewer, id, shareToken);
  if (!fit) return null;
  const versions = await db
    .select()
    .from(fittingVersions)
    .where(eq(fittingVersions.fittingId, id))
    .orderBy(desc(fittingVersions.version));
  return { fit, versions };
}

/** The fit, if this viewer may see it; a share token counts for "link" fits. Not-found and forbidden look alike. */
export async function viewableFitting(viewer: Viewer | null, id: string, shareToken?: string) {
  if (!z.uuid().safeParse(id).success) return null;
  const [row] = await fitQuery().where(eq(fittings.id, id));
  return row && canViewFitting(viewer, row, shareToken) ? row : null;
}

export async function fittingByShareToken(viewer: Viewer | null, shareToken: string) {
  const [row] = await fitQuery().where(eq(fittings.shareToken, shareToken));
  return row && canViewFitting(viewer, row, shareToken) ? row : null;
}

/** Saves a private copy of a fit the viewer can see into their own collection. */
export async function copyFitting(viewer: Viewer, id: string, shareToken?: string): Promise<string> {
  const source = await viewableFitting(viewer, id, shareToken);
  if (!source) throw new FittingError("Fit not found.");
  const contents = { name: source.name, description: source.description, shipTypeId: source.shipTypeId, items: source.items };
  return db.transaction((tx) => insertFitting(tx, viewer, contents, null, "copied"));
}

function fitQuery() {
  // Built per call: `db` connects on first use, and a module-level query would connect at import.
  const mainCharacter = db
    .select({ userId: characters.userId, id: characters.id, name: characters.name, corporationId: characters.corporationId })
    .from(characters)
    .innerJoin(users, eq(users.mainCharacterId, characters.id))
    .as("main_character");
  return db
    .select({
      id: fittings.id,
      ownerId: fittings.ownerId,
      name: fittings.name,
      description: fittings.description,
      shipTypeId: fittings.shipTypeId,
      shipName: eveTypes.name,
      items: fittings.items,
      visibility: fittings.visibility,
      corporationId: fittings.corporationId,
      shareToken: fittings.shareToken,
      createdAt: fittings.createdAt,
      updatedAt: fittings.updatedAt,
      ownerMainId: mainCharacter.id,
      ownerMainName: mainCharacter.name,
      // Where the owner's main is now: decides which Corp Director may moderate the owner's public fits.
      ownerCorporationId: mainCharacter.corporationId,
    })
    .from(fittings)
    .leftJoin(eveTypes, eq(eveTypes.id, fittings.shipTypeId))
    .leftJoin(mainCharacter, eq(mainCharacter.userId, fittings.ownerId));
}

export type FitRow = NonNullable<Awaited<ReturnType<typeof viewableFitting>>>;

function search(query: string | undefined): SQL | undefined {
  const q = query?.trim();
  if (!q) return undefined;
  const pattern = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  return or(ilike(fittings.name, pattern), ilike(eveTypes.name, pattern));
}

export async function listOwnFittings(viewer: Viewer, query?: string) {
  return fitQuery()
    .where(and(eq(fittings.ownerId, viewer.userId), search(query)))
    .orderBy(eveTypes.name, fittings.name);
}

/** Shared fits from the viewer's (main's) corporation, or the public library. */
export async function listLibrary(viewer: Viewer | null, scope: "corporation" | "public", query?: string) {
  const corporationId = corporationOf(viewer);
  if (scope === "corporation" && corporationId === null) return [];
  const scoped =
    scope === "corporation"
      ? and(eq(fittings.visibility, "corporation"), eq(fittings.corporationId, corporationId!))
      : eq(fittings.visibility, "public");
  return fitQuery()
    .where(and(scoped, search(query)))
    .orderBy(desc(fittings.updatedAt))
    .limit(200);
}

// --- In-game fittings -------------------------------------------------------------------------

type GameFitting = { fitting_id: number; name: string; description: string; ship_type_id: number; items: FittingItem[] };

/** A character's fits saved in game, each marked when an identical fit is already in the collection. */
export async function gameFittings(viewer: Viewer, characterId: number) {
  const token = await characterAccessToken(viewer.userId, characterId, "fittings");
  const fits = await esi<GameFitting[]>(`/characters/${characterId}/fittings`, { token });
  const types = await typesById(fits.flatMap((fit) => [fit.ship_type_id, ...fit.items.map((item) => item.type_id)]));
  const saved = new Set(
    (await db.select({ shipTypeId: fittings.shipTypeId, items: fittings.items }).from(fittings).where(eq(fittings.ownerId, viewer.userId))).map(
      (fit) => fitSignature(fit.shipTypeId, fit.items),
    ),
  );
  return fits
    .map((fit) => ({
      ...fit,
      shipName: types.get(fit.ship_type_id)?.name ?? `Type ${fit.ship_type_id}`,
      alreadySaved: saved.has(fitSignature(fit.ship_type_id, fit.items)),
    }))
    .sort((a, b) => a.shipName.localeCompare(b.shipName) || a.name.localeCompare(b.name));
}

export async function importGameFittings(viewer: Viewer, characterId: number, fittingIds: number[]): Promise<number> {
  const wanted = new Set(fittingIds);
  const chosen = (await gameFittings(viewer, characterId)).filter((fit) => wanted.has(fit.fitting_id) && !fit.alreadySaved);
  if (chosen.length === 0) return 0;
  await db.transaction(async (tx) => {
    for (const fit of chosen) {
      const contents = {
        name: fit.name,
        description: fit.description,
        shipTypeId: fit.ship_type_id,
        // "Invalid" entries are discarded by the game anyway; keeping them would only fail a later send.
        items: fit.items.filter((item) => item.flag !== "Invalid"),
      };
      await insertFitting(tx, viewer, contents, null, "imported");
    }
  });
  return chosen.length;
}

export async function sendToGame(viewer: Viewer, id: string, characterId: number, shareToken?: string): Promise<void> {
  const fit = await viewableFitting(viewer, id, shareToken);
  if (!fit) throw new FittingError("Fit not found.");
  const token = await characterAccessToken(viewer.userId, characterId, "fittings");
  await esi<{ fitting_id: number }>(`/characters/${characterId}/fittings`, {
    method: "POST",
    token,
    body: { name: fit.name.slice(0, 50), description: fit.description.slice(0, 500), ship_type_id: fit.shipTypeId, items: fit.items },
  });
}

// Sends run one after another inside a single request; this keeps a run well inside a serverless
// function's time limit (each ESI write takes a few hundred milliseconds).
export const BULK_SEND_LIMIT = 50;

export type BulkSendResult = { id: string; name: string; status: "sent" | "skipped" | "failed"; detail?: string };

/**
 * Sends several fits to one character. Fits already saved on the character (same contents, any
 * slot numbers) are skipped, so re-running after a partial failure only sends what is missing.
 * A failure on one fit does not stop the rest, except when the character's access itself is gone.
 */
export async function sendManyToGame(viewer: Viewer, ids: string[], characterId: number): Promise<BulkSendResult[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new FittingError("Select at least one fit.");
  if (unique.length > BULK_SEND_LIMIT) throw new FittingError(`Send at most ${BULK_SEND_LIMIT} fits at a time.`);

  const fits = (await Promise.all(unique.map((id) => viewableFitting(viewer, id)))).filter((fit) => fit !== null);
  const token = await characterAccessToken(viewer.userId, characterId, "fittings");
  const inGame = new Set(
    (await esi<GameFitting[]>(`/characters/${characterId}/fittings`, { token })).map((fit) => fitSignature(fit.ship_type_id, fit.items)),
  );

  const results: BulkSendResult[] = [];
  for (const fit of fits) {
    const signature = fitSignature(fit.shipTypeId, fit.items);
    if (inGame.has(signature)) {
      results.push({ id: fit.id, name: fit.name, status: "skipped", detail: "already saved on this character" });
      continue;
    }
    try {
      await esi(`/characters/${characterId}/fittings`, {
        method: "POST",
        token,
        body: { name: fit.name.slice(0, 50), description: fit.description.slice(0, 500), ship_type_id: fit.shipTypeId, items: fit.items },
      });
      inGame.add(signature);
      results.push({ id: fit.id, name: fit.name, status: "sent" });
    } catch (error) {
      if (!(error instanceof EsiError)) throw error;
      results.push({ id: fit.id, name: fit.name, status: "failed", detail: error.message });
      // A rejected token fails every remaining send the same way; report it once and stop.
      if (error.status === 401 || error.status === 403) break;
    }
  }
  return results;
}
