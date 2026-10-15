import "server-only";
import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { characters, eveTypes, fittings, users, type Fitting, type FittingItem } from "@/db/schema";
import type { Viewer } from "@/lib/auth/accounts";
import { characterAccessToken } from "@/lib/auth/tokens";
import { randomToken } from "@/lib/crypto";
import { esi } from "@/lib/eve/esi";
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

export async function createFitting(viewer: Viewer, input: FitInput): Promise<{ id: string; warnings: string[] }> {
  const data = fitInput.parse(input);
  const fit = await fitFromEft(data.eft, data.name);
  const [row] = await db
    .insert(fittings)
    .values({
      ownerId: viewer.userId,
      name: fit.name,
      description: data.description,
      shipTypeId: fit.shipTypeId,
      items: fit.items,
      ...sharing(viewer, data.visibility),
    })
    .returning({ id: fittings.id });
  return { id: row.id, warnings: fit.warnings };
}

async function ownFitting(viewer: Viewer, id: string): Promise<Fitting> {
  const [fit] = await db.select().from(fittings).where(eq(fittings.id, id));
  if (!fit || !canEditFitting(viewer, fit)) throw new FittingError("Fit not found.");
  return fit;
}

export async function updateFitting(viewer: Viewer, id: string, input: FitInput): Promise<{ warnings: string[] }> {
  const data = fitInput.parse(input);
  const current = await ownFitting(viewer, id);
  const fit = await fitFromEft(data.eft, data.name);
  await db
    .update(fittings)
    .set({
      name: fit.name,
      description: data.description,
      shipTypeId: fit.shipTypeId,
      items: fit.items,
      updatedAt: new Date(),
      ...sharing(viewer, data.visibility, current),
    })
    .where(eq(fittings.id, id));
  return { warnings: fit.warnings };
}

export async function setVisibility(viewer: Viewer, id: string, visibility: Visibility): Promise<void> {
  const current = await ownFitting(viewer, id);
  await db
    .update(fittings)
    .set({ ...sharing(viewer, visibility, current), updatedAt: new Date() })
    .where(eq(fittings.id, id));
}

export async function deleteFitting(viewer: Viewer, id: string): Promise<void> {
  const [fit] = await db.select().from(fittings).where(eq(fittings.id, id));
  if (!fit || !canDeleteFitting(viewer, fit)) throw new FittingError("Fit not found.");
  await db.delete(fittings).where(eq(fittings.id, id));
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
  const [row] = await db
    .insert(fittings)
    .values({
      ownerId: viewer.userId,
      name: source.name,
      description: source.description,
      shipTypeId: source.shipTypeId,
      items: source.items,
    })
    .returning({ id: fittings.id });
  return row.id;
}

function fitQuery() {
  // Built per call: `db` connects on first use, and a module-level query would connect at import.
  const mainCharacter = db
    .select({ userId: characters.userId, id: characters.id, name: characters.name })
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
  await db.insert(fittings).values(
    chosen.map((fit) => ({
      ownerId: viewer.userId,
      name: fit.name,
      description: fit.description,
      shipTypeId: fit.ship_type_id,
      // "Invalid" entries are discarded by the game anyway; keeping them would only fail a later send.
      items: fit.items.filter((item) => item.flag !== "Invalid"),
    })),
  );
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
