"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { currentUserId } from "@/lib/auth/session";
import { deleteRattingHistory } from "@/lib/ratting/sync";

export async function deleteHistory(characterId: number) {
  const userId = await currentUserId();
  if (!userId) redirect("/");
  await deleteRattingHistory(userId, characterId);
  refresh();
}
