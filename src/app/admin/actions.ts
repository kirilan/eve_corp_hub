"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { setDirector, setSuperUser } from "@/lib/auth/super-users";
import { getViewer } from "@/lib/auth/viewer";

export async function toggleSuperUser(userId: string, value: boolean) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  await setSuperUser(viewer, userId, value);
  refresh();
}

export async function toggleDirector(userId: string, corporationId: number, value: boolean) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  await setDirector(viewer, userId, corporationId, value);
  refresh();
}
