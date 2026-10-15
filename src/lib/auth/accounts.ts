import "server-only";
import { and, asc, eq, isNull, lt, or } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { type Character, characters, corporationDirectors, users } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { affiliations, type Affiliation } from "@/lib/eve/esi";
import { revokeRefreshToken, type TokenResponse, type VerifiedCharacter } from "@/lib/eve/sso";

export type Intent = "login" | "link";

export type SignInResult = {
  userId: string;
  characterId: number;
  outcome: "created" | "signed-in" | "linked" | "updated";
};

export class LinkConflictError extends Error {
  constructor(readonly characterName: string) {
    super(`${characterName} is already linked to another profile`);
  }
}

/**
 * Applies one successful SSO callback.
 *
 * - `login`: an unknown character starts a new profile with itself as main; a known one signs
 *   its profile in.
 * - `link` (signed in): an unknown character joins the current profile; one already in the
 *   current profile just has its tokens/scopes updated; one in another profile is refused - the
 *   owner must unlink it there first, so nobody can pull a character out of someone else's profile.
 *
 * A character whose owner hash changed was sold or transferred: it leaves its old profile before
 * anything else happens, and then counts as unknown.
 */
export async function completeSignIn(input: {
  intent: Intent;
  currentUserId: string | null;
  verified: VerifiedCharacter;
  tokens: TokenResponse;
  affiliation: Affiliation | null;
}): Promise<SignInResult> {
  const { verified, tokens, affiliation } = input;
  const now = new Date();
  const fields = {
    name: verified.name,
    ownerHash: verified.ownerHash,
    lastLoginAt: now,
    ...(affiliation && {
      corporationId: affiliation.corporation_id,
      allianceId: affiliation.alliance_id ?? null,
      affiliationCheckedAt: now,
    }),
    // A scope-less sign-in must not overwrite a token that carries consent granted earlier.
    ...(verified.scopes.length > 0 &&
      tokens.refresh_token && {
        scopes: verified.scopes,
        refreshTokenEnc: encrypt(tokens.refresh_token),
        accessTokenEnc: encrypt(tokens.access_token),
        accessTokenExpiresAt: verified.expiresAt,
        tokenError: null,
      }),
  };

  return db.transaction(async (tx) => {
    let existing: Character | undefined = (
      await tx.select().from(characters).where(eq(characters.id, verified.characterId)).for("update")
    )[0];
    if (existing && existing.ownerHash !== verified.ownerHash) {
      await detachCharacter(tx, existing);
      existing = undefined;
    }

    if (input.intent === "link" && input.currentUserId) {
      if (existing && existing.userId !== input.currentUserId) throw new LinkConflictError(verified.name);
      if (existing) {
        await tx.update(characters).set(fields).where(eq(characters.id, existing.id));
        return { userId: existing.userId, characterId: existing.id, outcome: "updated" };
      }
      await tx.insert(characters).values({ id: verified.characterId, userId: input.currentUserId, ...fields });
      return { userId: input.currentUserId, characterId: verified.characterId, outcome: "linked" };
    }

    if (existing) {
      await tx.update(characters).set(fields).where(eq(characters.id, existing.id));
      return { userId: existing.userId, characterId: existing.id, outcome: "signed-in" };
    }
    const [user] = await tx.insert(users).values({ mainCharacterId: verified.characterId }).returning({ id: users.id });
    await tx.insert(characters).values({ id: verified.characterId, userId: user.id, ...fields });
    return { userId: user.id, characterId: verified.characterId, outcome: "created" };
  });
}

/** Removes a character from its profile, handing the main role to the oldest remaining character. */
export async function detachCharacter(tx: Tx, character: Character) {
  await tx.delete(characters).where(eq(characters.id, character.id));
  const [owner] = await tx.select().from(users).where(eq(users.id, character.userId));
  if (owner?.mainCharacterId !== character.id) return;
  const [successor] = await tx
    .select({ id: characters.id })
    .from(characters)
    .where(eq(characters.userId, character.userId))
    .orderBy(asc(characters.createdAt), asc(characters.id))
    .limit(1);
  // No successor leaves a profile nobody can sign in to; its fits stay until an admin cleans up.
  await tx.update(users).set({ mainCharacterId: successor?.id ?? null }).where(eq(users.id, character.userId));
}

export async function setMainCharacter(userId: string, characterId: number): Promise<void> {
  const [own] = await db
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.userId, userId)));
  if (!own) throw new Error("that character is not linked to your profile");
  await db.update(users).set({ mainCharacterId: characterId }).where(eq(users.id, userId));
}

export async function unlinkCharacter(userId: string, characterId: number): Promise<void> {
  const refreshToken = await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.id, userId)).for("update");
    if (!user) throw new Error("profile not found");
    if (user.mainCharacterId === characterId) {
      throw new Error("pick another main character before unlinking this one");
    }
    const [deleted] = await tx
      .delete(characters)
      .where(and(eq(characters.id, characterId), eq(characters.userId, userId)))
      .returning({ refreshTokenEnc: characters.refreshTokenEnc });
    if (!deleted) throw new Error("that character is not linked to your profile");
    return deleted.refreshTokenEnc;
  });
  if (refreshToken) await revokeRefreshToken(decrypt(refreshToken));
}

/** Drops a feature's consent by forgetting the token; the owner can grant it again any time. */
export async function revokeCharacterScopes(userId: string, characterId: number): Promise<void> {
  const [cleared] = await db
    .select({ refreshTokenEnc: characters.refreshTokenEnc })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.userId, userId)));
  if (!cleared) throw new Error("that character is not linked to your profile");
  await db
    .update(characters)
    .set({ scopes: [], refreshTokenEnc: null, accessTokenEnc: null, accessTokenExpiresAt: null, tokenError: null })
    .where(eq(characters.id, characterId));
  if (cleared.refreshTokenEnc) await revokeRefreshToken(decrypt(cleared.refreshTokenEnc));
}

const AFFILIATION_MAX_AGE_MS = 60 * 60 * 1000; // ESI caches /characters/affiliation for an hour anyway

/**
 * Re-reads corporation/alliance for a profile's characters when the stored value is over an hour
 * old. Permissions hang off the main's corporation, so someone who leaves the corp loses corp
 * access within the hour without signing in again. An ESI outage keeps the last known value.
 */
export async function refreshAffiliations(userId: string): Promise<void> {
  const stale = await db
    .select({ id: characters.id })
    .from(characters)
    .where(
      and(
        eq(characters.userId, userId),
        or(isNull(characters.affiliationCheckedAt), lt(characters.affiliationCheckedAt, new Date(Date.now() - AFFILIATION_MAX_AGE_MS))),
      ),
    );
  if (stale.length === 0) return;
  let fresh: Affiliation[];
  try {
    fresh = await affiliations(stale.map((c) => c.id));
  } catch (error) {
    console.warn("affiliation refresh failed; keeping stored values", error);
    return;
  }
  const now = new Date();
  for (const a of fresh) {
    await db
      .update(characters)
      .set({ corporationId: a.corporation_id, allianceId: a.alliance_id ?? null, affiliationCheckedAt: now })
      .where(eq(characters.id, a.character_id));
  }
}

export type Viewer = {
  userId: string;
  isSuperUser: boolean;
  // Corporations this profile holds a Corp Director role for; effective only for the main's corporation.
  directorOf: number[];
  main: { id: number; name: string; corporationId: number | null; allianceId: number | null } | null;
};

export async function loadViewer(userId: string): Promise<Viewer | null> {
  const [row] = await db
    .select({
      userId: users.id,
      isSuperUser: users.isSuperUser,
      mainId: characters.id,
      mainName: characters.name,
      corporationId: characters.corporationId,
      allianceId: characters.allianceId,
    })
    .from(users)
    .leftJoin(characters, and(eq(characters.id, users.mainCharacterId), eq(characters.userId, users.id)))
    .where(eq(users.id, userId));
  if (!row) return null;
  const roles = await db
    .select({ corporationId: corporationDirectors.corporationId })
    .from(corporationDirectors)
    .where(eq(corporationDirectors.userId, userId));
  return {
    userId: row.userId,
    isSuperUser: row.isSuperUser,
    directorOf: roles.map((role) => role.corporationId),
    main:
      row.mainId === null
        ? null
        : { id: row.mainId, name: row.mainName ?? "", corporationId: row.corporationId, allianceId: row.allianceId },
  };
}

export async function listCharacters(userId: string) {
  return db
    .select({
      id: characters.id,
      name: characters.name,
      corporationId: characters.corporationId,
      allianceId: characters.allianceId,
      scopes: characters.scopes,
      tokenError: characters.tokenError,
      createdAt: characters.createdAt,
    })
    .from(characters)
    .where(eq(characters.userId, userId))
    .orderBy(asc(characters.createdAt), asc(characters.id));
}
