import "server-only";
import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { characters, corporationDirectors, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { FittingError } from "@/lib/fittings/store";
import { canAdminister, canGrantDirector, canGrantSuperUser, corporationOf, runsCorporation } from "@/lib/permissions";
import type { Viewer } from "./accounts";

/**
 * Profiles for the admin page, by main character: every profile for super users, only those whose
 * main is in their corporation for Corp Directors. Each comes with its director roles.
 */
export async function listProfiles(viewer: Viewer) {
  if (!canAdminister(viewer)) return [];
  const own = corporationOf(viewer);
  const rows = await db
    .select({
      userId: users.id,
      isSuperUser: users.isSuperUser,
      mainId: characters.id,
      mainName: characters.name,
      corporationId: characters.corporationId,
    })
    .from(users)
    .leftJoin(characters, eq(characters.id, users.mainCharacterId))
    .where(viewer.isSuperUser ? undefined : eq(characters.corporationId, own!))
    .orderBy(asc(characters.name));
  const roles = await db.select().from(corporationDirectors);
  return rows.map((row) => ({
    ...row,
    directorOf: roles.filter((role) => role.userId === row.userId).map((role) => role.corporationId),
  }));
}

async function target(userId: string) {
  const [row] = await db
    .select({ isSuperUser: users.isSuperUser, mainName: characters.name, corporationId: characters.corporationId })
    .from(users)
    .leftJoin(characters, eq(characters.id, users.mainCharacterId))
    .where(eq(users.id, userId));
  if (!row) throw new FittingError("Profile not found.");
  return row;
}

/** Grants or revokes the site-wide super user flag. Super users only, never on themselves. */
export async function setSuperUser(viewer: Viewer, userId: string, value: boolean): Promise<void> {
  if (!viewer.isSuperUser) throw new FittingError("Only super users can change this.");
  if (!canGrantSuperUser(viewer, userId)) throw new FittingError("Ask another super user to change your own flag.");
  const profile = await target(userId);
  if (profile.isSuperUser === value) return;
  await db.transaction(async (tx) => {
    await tx.update(users).set({ isSuperUser: value }).where(eq(users.id, userId));
    await audit(tx, viewer, {
      action: value ? "user.super_granted" : "user.super_revoked",
      subjectType: "user",
      subjectId: userId,
      subjectName: profile.mainName ?? "profile without a main",
      // Site-wide: the flag is not tied to a corporation.
      corporationId: null,
    });
  });
}

/**
 * Grants a Corp Director role for the corporation the target's main is in now, or revokes the role
 * for one corporation. Super users may do either for anyone; directors only within their own
 * corporation. Nobody changes their own roles.
 */
export async function setDirector(viewer: Viewer, userId: string, corporationId: number, value: boolean): Promise<void> {
  if (userId === viewer.userId) throw new FittingError("Ask another admin to change your own role.");
  const profile = await target(userId);
  if (value) {
    if (profile.corporationId !== corporationId) throw new FittingError("A director role is granted for the corporation the profile's main is in.");
    if (!canGrantDirector(viewer, { userId, corporationId })) throw new FittingError("You can only appoint directors in your own corporation.");
  } else if (!viewer.isSuperUser && !runsCorporation(viewer, corporationId)) {
    throw new FittingError("You can only remove directors of your own corporation.");
  }
  await db.transaction(async (tx) => {
    const changed = value
      ? await tx.insert(corporationDirectors).values({ userId, corporationId, grantedBy: viewer.userId }).onConflictDoNothing().returning()
      : await tx
          .delete(corporationDirectors)
          .where(and(eq(corporationDirectors.userId, userId), eq(corporationDirectors.corporationId, corporationId)))
          .returning();
    if (changed.length === 0) return;
    await audit(tx, viewer, {
      action: value ? "user.director_granted" : "user.director_revoked",
      subjectType: "user",
      subjectId: userId,
      subjectName: profile.mainName ?? "profile without a main",
      corporationId,
    });
  });
}
