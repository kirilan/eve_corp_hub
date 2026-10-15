import "server-only";
import { asc, eq } from "drizzle-orm";
import { db } from "@/db";
import { characters, users } from "@/db/schema";
import { audit } from "@/lib/audit";
import { FittingError } from "@/lib/fittings/store";
import type { Viewer } from "./accounts";

/** Every profile by its main character, for the super user admin page. */
export async function listProfiles(viewer: Viewer) {
  if (!viewer.isSuperUser) return [];
  return db
    .select({
      userId: users.id,
      isSuperUser: users.isSuperUser,
      mainId: characters.id,
      mainName: characters.name,
      corporationId: characters.corporationId,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(characters, eq(characters.id, users.mainCharacterId))
    .orderBy(asc(characters.name));
}

/** Grants or revokes the super user flag. Super users only, and never on themselves (no accidental lock-out). */
export async function setSuperUser(viewer: Viewer, userId: string, value: boolean): Promise<void> {
  if (!viewer.isSuperUser) throw new FittingError("Only super users can change this.");
  if (userId === viewer.userId) throw new FittingError("Ask another super user to change your own flag.");
  await db.transaction(async (tx) => {
    const [target] = await tx
      .select({ isSuperUser: users.isSuperUser, mainName: characters.name })
      .from(users)
      .leftJoin(characters, eq(characters.id, users.mainCharacterId))
      .where(eq(users.id, userId))
      .for("update", { of: users });
    if (!target) throw new FittingError("Profile not found.");
    if (target.isSuperUser === value) return;
    await tx.update(users).set({ isSuperUser: value }).where(eq(users.id, userId));
    await audit(tx, viewer, {
      action: value ? "user.super_granted" : "user.super_revoked",
      subjectType: "user",
      subjectId: userId,
      subjectName: target.mainName ?? "profile without a main",
      // Site-wide: the flag is not tied to a corporation.
      corporationId: null,
    });
  });
}
