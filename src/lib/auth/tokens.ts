import "server-only";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { characters } from "@/db/schema";
import { decrypt, encrypt } from "@/lib/crypto";
import { hasFeature, refreshAccessToken, SsoError, verifyAccessToken, type Feature } from "@/lib/eve/sso";
import { detachCharacter } from "./accounts";

const REFRESH_LEEWAY_MS = 60_000;

export class ConsentMissingError extends Error {
  constructor(
    readonly characterId: number,
    readonly feature: Feature,
  ) {
    super(`this character has not granted access for ${feature}`);
  }
}

/**
 * A live ESI access token for one of the user's own characters, refreshed when within a minute of
 * expiry. The row lock is held across the refresh on purpose: refresh tokens rotate, so two
 * requests must never spend the same one - the loser waits, then finds the fresh token.
 */
export async function characterAccessToken(userId: string, characterId: number, feature: Feature): Promise<string> {
  // Failures that change the row are returned, not thrown: a throw would roll back the change.
  const result = await db.transaction(async (tx): Promise<{ token: string } | { error: Error }> => {
    const [character] = await tx
      .select()
      .from(characters)
      .where(and(eq(characters.id, characterId), eq(characters.userId, userId)))
      .for("update");
    if (!character) throw new Error("that character is not linked to your profile");
    if (!character.refreshTokenEnc || !hasFeature(character.scopes, feature)) {
      throw new ConsentMissingError(characterId, feature);
    }
    if (
      character.accessTokenEnc &&
      character.accessTokenExpiresAt &&
      character.accessTokenExpiresAt.getTime() - REFRESH_LEEWAY_MS > Date.now()
    ) {
      return { token: decrypt(character.accessTokenEnc) };
    }

    let tokens;
    try {
      tokens = await refreshAccessToken(decrypt(character.refreshTokenEnc));
    } catch (error) {
      if (error instanceof SsoError && error.invalidGrant) {
        await tx
          .update(characters)
          .set({ scopes: [], refreshTokenEnc: null, accessTokenEnc: null, accessTokenExpiresAt: null, tokenError: error.message })
          .where(eq(characters.id, characterId));
        return { error: new ConsentMissingError(characterId, feature) };
      }
      throw error;
    }
    const verified = await verifyAccessToken(tokens.access_token);
    if (verified.ownerHash !== character.ownerHash) {
      await detachCharacter(tx, character);
      return { error: new Error(`${character.name} now belongs to another EVE account and was removed from your profile`) };
    }
    await tx
      .update(characters)
      .set({
        accessTokenEnc: encrypt(tokens.access_token),
        accessTokenExpiresAt: verified.expiresAt,
        scopes: verified.scopes,
        tokenError: null,
        ...(tokens.refresh_token && { refreshTokenEnc: encrypt(tokens.refresh_token) }),
      })
      .where(eq(characters.id, characterId));
    return { token: tokens.access_token };
  });
  if ("error" in result) throw result.error;
  return result.token;
}
