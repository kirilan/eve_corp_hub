"use server";

import { redirect } from "next/navigation";
import { listCharacters } from "@/lib/auth/accounts";
import { currentUserId } from "@/lib/auth/session";
import { ConsentMissingError } from "@/lib/auth/tokens";
import { EsiError } from "@/lib/eve/esi";
import { AppraisalError, appraiseItems } from "@/lib/industry/appraisal";
import { characterRates } from "@/lib/industry/character";
import { isHub } from "@/lib/industry/hubs";
import type { CharacterData } from "@/lib/industry/rates";
import type { Appraisal } from "@/lib/industry/reprocess";

export type AppraiseState = { appraisal?: Appraisal; error?: string };

// Server Functions are public endpoints: each reads the session itself, whatever the page showed.
async function requireUserId(): Promise<string> {
  const userId = await currentUserId();
  if (!userId) redirect("/");
  return userId;
}

export async function appraise(_: AppraiseState, form: FormData): Promise<AppraiseState> {
  const userId = await requireUserId();
  const hub = form.get("hub");
  if (!isHub(hub)) return { error: "Choose where the items are." };
  try {
    return { appraisal: await appraiseItems(userId, String(form.get("items") ?? ""), hub) };
  } catch (error) {
    if (error instanceof AppraisalError) return { error: error.message };
    if (error instanceof EsiError) return { error: `EVE did not answer: ${error.message}. Try again in a moment.` };
    throw error;
  }
}

export type CharacterState = { character?: CharacterData; error?: string };

/** Skills and standings of one of the viewer's own characters, to estimate yields, taxes and fees. */
export async function loadCharacter(characterId: number): Promise<CharacterState> {
  const userId = await requireUserId();
  const own = (await listCharacters(userId)).find((character) => character.id === characterId);
  if (!Number.isSafeInteger(characterId) || !own) return { error: "That character is not on your profile." };
  try {
    return { character: await characterRates(userId, own.id, own.name) };
  } catch (error) {
    if (error instanceof ConsentMissingError) return { error: `${own.name} does not allow reading skills and standings. Allow it on Characters.` };
    if (error instanceof EsiError) return { error: `EVE did not answer for ${own.name}: ${error.message}. Try again in a moment.` };
    throw error;
  }
}
