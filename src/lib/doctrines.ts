import "server-only";
import { and, asc, count, eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import { doctrineFittings, doctrines, fittings, type Doctrine } from "@/db/schema";
import { audit } from "@/lib/audit";
import type { Viewer } from "@/lib/auth/accounts";
import { FittingError, viewableFitting, type FitRow } from "@/lib/fittings/store";
import { canManageDoctrines, canViewFitting, corporationOf, fitsDoctrine } from "@/lib/permissions";

export const doctrineInput = z.object({
  name: z.string().trim().min(1, "Give the doctrine a name.").max(80, "Keep the name under 80 characters."),
  description: z.string().trim().max(2000, "Keep the description under 2000 characters.").default(""),
});
export type DoctrineInput = z.input<typeof doctrineInput>;

/** The viewer's corporation's doctrines with how many fits each holds. */
export async function listDoctrines(viewer: Viewer | null) {
  const corporationId = corporationOf(viewer);
  if (corporationId === null) return [];
  return db
    .select({ id: doctrines.id, name: doctrines.name, description: doctrines.description, fits: count(doctrineFittings.fittingId) })
    .from(doctrines)
    .leftJoin(doctrineFittings, eq(doctrineFittings.doctrineId, doctrines.id))
    .where(eq(doctrines.corporationId, corporationId))
    .groupBy(doctrines.id)
    .orderBy(asc(doctrines.name));
}

async function findDoctrine(viewer: Viewer | null, id: string): Promise<Doctrine | null> {
  if (!z.uuid().safeParse(id).success) return null;
  const [doctrine] = await db.select().from(doctrines).where(eq(doctrines.id, id));
  // Members of the doctrine's corporation only; anyone else gets "not found".
  return doctrine && doctrine.corporationId === corporationOf(viewer) ? doctrine : null;
}

/**
 * A doctrine and the fits in it that the viewer can see. A fit whose owner has since made it
 * private (or moved it to another corporation) drops out of view and is counted as hidden.
 */
export async function doctrineWithFits(viewer: Viewer | null, id: string) {
  const doctrine = await findDoctrine(viewer, id);
  if (!doctrine) return null;
  const linked = await db
    .select({ fittingId: doctrineFittings.fittingId })
    .from(doctrineFittings)
    .where(eq(doctrineFittings.doctrineId, id))
    .orderBy(asc(doctrineFittings.addedAt));
  const fits = (await Promise.all(linked.map(({ fittingId }) => viewableFitting(viewer, fittingId)))).filter(
    (fit): fit is FitRow => fit !== null && fitsDoctrine(fit, doctrine.corporationId),
  );
  return { doctrine, fits, hidden: linked.length - fits.length };
}

function requireManager(viewer: Viewer, corporationId?: number) {
  if (!canManageDoctrines(viewer, corporationId)) throw new FittingError("Only this corporation's directors and super users manage its doctrines.");
}

export async function createDoctrine(viewer: Viewer, input: DoctrineInput): Promise<string> {
  requireManager(viewer);
  const data = doctrineInput.parse(input);
  const corporationId = corporationOf(viewer)!;
  return db.transaction(async (tx) => {
    const [row] = await tx.insert(doctrines).values({ corporationId, ...data }).returning({ id: doctrines.id });
    await audit(tx, viewer, { action: "doctrine.created", subjectType: "doctrine", subjectId: row.id, subjectName: data.name, corporationId });
    return row.id;
  });
}

export async function updateDoctrine(viewer: Viewer, id: string, input: DoctrineInput): Promise<void> {
  const data = doctrineInput.parse(input);
  const doctrine = await findDoctrine(viewer, id);
  if (!doctrine) throw new FittingError("Doctrine not found.");
  requireManager(viewer, doctrine.corporationId);
  await db.transaction(async (tx) => {
    await tx.update(doctrines).set({ ...data, updatedAt: new Date() }).where(eq(doctrines.id, id));
    await audit(tx, viewer, {
      action: "doctrine.edited",
      subjectType: "doctrine",
      subjectId: id,
      subjectName: data.name,
      corporationId: doctrine.corporationId,
      details: data.name !== doctrine.name ? { renamedFrom: doctrine.name } : {},
    });
  });
}

export async function deleteDoctrine(viewer: Viewer, id: string): Promise<void> {
  const doctrine = await findDoctrine(viewer, id);
  if (!doctrine) throw new FittingError("Doctrine not found.");
  requireManager(viewer, doctrine.corporationId);
  await db.transaction(async (tx) => {
    await tx.delete(doctrines).where(eq(doctrines.id, id));
    await audit(tx, viewer, { action: "doctrine.deleted", subjectType: "doctrine", subjectId: id, subjectName: doctrine.name, corporationId: doctrine.corporationId });
  });
}

export async function addFitToDoctrine(viewer: Viewer, doctrineId: string, fittingId: string): Promise<void> {
  const doctrine = await findDoctrine(viewer, doctrineId);
  if (!doctrine) throw new FittingError("Doctrine not found.");
  requireManager(viewer, doctrine.corporationId);
  const fit = await viewableFitting(viewer, fittingId);
  if (!fit) throw new FittingError("Fit not found.");
  if (!fitsDoctrine(fit, doctrine.corporationId)) {
    throw new FittingError("Only fits shared with the corporation (or public) can be part of a doctrine, so every member can see them.");
  }
  await db.transaction(async (tx) => {
    const inserted = await tx.insert(doctrineFittings).values({ doctrineId, fittingId }).onConflictDoNothing().returning();
    if (inserted.length === 0) return;
    await audit(tx, viewer, {
      action: "doctrine.fit_added",
      subjectType: "doctrine",
      subjectId: doctrineId,
      subjectName: doctrine.name,
      corporationId: doctrine.corporationId,
      details: { fittingId, fit: fit.name },
    });
  });
}

export async function removeFitFromDoctrine(viewer: Viewer, doctrineId: string, fittingId: string): Promise<void> {
  const doctrine = await findDoctrine(viewer, doctrineId);
  if (!doctrine) throw new FittingError("Doctrine not found.");
  requireManager(viewer, doctrine.corporationId);
  await db.transaction(async (tx) => {
    const removed = await tx
      .delete(doctrineFittings)
      .where(and(eq(doctrineFittings.doctrineId, doctrineId), eq(doctrineFittings.fittingId, fittingId)))
      .returning();
    if (removed.length === 0) return;
    const [fit] = await tx.select({ name: fittings.name }).from(fittings).where(eq(fittings.id, fittingId));
    await audit(tx, viewer, {
      action: "doctrine.fit_removed",
      subjectType: "doctrine",
      subjectId: doctrineId,
      subjectName: doctrine.name,
      corporationId: doctrine.corporationId,
      details: { fittingId, fit: fit?.name ?? null },
    });
  });
}

/** Doctrines of the viewer's corporation, each marked with whether it already holds the fit. For the fit page. */
export async function doctrinesForFit(viewer: Viewer, fit: Pick<FitRow, "id" | "ownerId" | "visibility" | "corporationId" | "shareToken">) {
  const corporationId = corporationOf(viewer);
  if (!canManageDoctrines(viewer) || corporationId === null || !canViewFitting(viewer, fit) || !fitsDoctrine(fit, corporationId)) {
    return [];
  }
  const all = await db.select({ id: doctrines.id, name: doctrines.name }).from(doctrines).where(eq(doctrines.corporationId, corporationId)).orderBy(asc(doctrines.name));
  const holding = new Set(
    (await db.select({ id: doctrineFittings.doctrineId }).from(doctrineFittings).where(eq(doctrineFittings.fittingId, fit.id))).map((row) => row.id),
  );
  return all.map((doctrine) => ({ ...doctrine, holds: holding.has(doctrine.id) }));
}
