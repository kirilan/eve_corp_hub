"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { revokeCharacterScopes, setMainCharacter, unlinkCharacter } from "@/lib/auth/accounts";
import { currentUserId } from "@/lib/auth/session";

// Every action re-reads the session itself: a Server Function is a public endpoint, whatever the UI shows.
async function requireUserId(): Promise<string> {
  const userId = await currentUserId();
  if (!userId) redirect("/");
  return userId;
}

export async function makeMain(characterId: number) {
  await setMainCharacter(await requireUserId(), characterId);
  refresh();
}

export async function unlink(characterId: number) {
  await unlinkCharacter(await requireUserId(), characterId);
  refresh();
}

export async function revokeAccess(characterId: number) {
  await revokeCharacterScopes(await requireUserId(), characterId);
  refresh();
}
