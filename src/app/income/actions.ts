"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { currentUserId } from "@/lib/auth/session";
import { deleteIncomeHistory } from "@/lib/income/sync";
import { setTradeExclusion } from "@/lib/trade/report";

export async function deleteHistory(characterId: number) {
  const userId = await currentUserId();
  if (!userId) redirect("/");
  await deleteIncomeHistory(userId, characterId);
  refresh();
}

/** Keeps an item out of trade performance (bought to use, not to sell), or brings it back. */
export async function setNotForTrade(typeId: number, excluded: boolean) {
  const userId = await currentUserId();
  if (!userId) redirect("/");
  await setTradeExclusion(userId, typeId, excluded);
  refresh();
}
