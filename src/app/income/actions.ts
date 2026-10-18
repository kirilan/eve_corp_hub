"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { currentUserId } from "@/lib/auth/session";
import { deleteIncomeHistory } from "@/lib/income/sync";

export async function deleteHistory(characterId: number) {
  const userId = await currentUserId();
  if (!userId) redirect("/");
  await deleteIncomeHistory(userId, characterId);
  refresh();
}
