"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/app/(fittings)/fittings/actions";
import { setDirector, setSuperUser } from "@/lib/auth/super-users";
import { getViewer } from "@/lib/auth/viewer";
import { CronJobError, runCronJobNow } from "@/lib/cron-jobs";

export async function toggleSuperUser(userId: string, value: boolean) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  await setSuperUser(viewer, userId, value);
  refresh();
}

/** "Run now" on the health panel. A failed run is already recorded on the panel; this reports it too. */
export async function runJob(path: string): Promise<FormState> {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  try {
    await runCronJobNow(viewer, path);
  } catch (error) {
    if (error instanceof CronJobError) return { error: error.message };
    refresh();
    return { error: `The run failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  refresh();
  return { ok: "Done." };
}

export async function toggleDirector(userId: string, corporationId: number, value: boolean) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  await setDirector(viewer, userId, corporationId, value);
  refresh();
}
