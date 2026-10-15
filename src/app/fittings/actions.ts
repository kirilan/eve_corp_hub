"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import type { Viewer } from "@/lib/auth/accounts";
import { ConsentMissingError } from "@/lib/auth/tokens";
import { getViewer } from "@/lib/auth/viewer";
import { EsiError } from "@/lib/eve/esi";
import {
  copyFitting,
  createFitting,
  deleteFitting,
  FittingError,
  importGameFittings,
  restoreVersion,
  sendManyToGame,
  sendToGame,
  setVisibility,
  updateFitting,
  VISIBILITIES,
  type BulkSendResult,
  type Visibility,
} from "@/lib/fittings/store";
import { z } from "zod";

export type FormState = { error?: string; ok?: string };

// Server Functions are public endpoints: each one resolves the viewer itself and never trusts the form for identity.
async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  return viewer;
}

/** Turns expected failures into a message for the form; anything else is a bug and should surface. */
function userMessage(error: unknown): string {
  if (error instanceof FittingError) return error.message;
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Invalid input.";
  if (error instanceof ConsentMissingError) return "That character has not allowed fitting sync. Allow it on the Characters page.";
  if (error instanceof EsiError) return `EVE refused the request: ${error.message}`;
  throw error;
}

function warningsQuery(warnings: string[]): string {
  return warnings.map((warning) => `&warn=${encodeURIComponent(warning)}`).join("");
}

export async function saveFit(fitId: string | null, _: FormState, form: FormData): Promise<FormState> {
  const viewer = await requireViewer();
  const input = {
    eft: String(form.get("eft") ?? ""),
    name: String(form.get("name") ?? "") || undefined,
    description: String(form.get("description") ?? ""),
    visibility: String(form.get("visibility") ?? "private") as Visibility,
  };
  let target: string;
  try {
    if (fitId) {
      const { warnings } = await updateFitting(viewer, fitId, input);
      target = `/fittings/${fitId}?notice=fit-saved${warningsQuery(warnings)}`;
    } else {
      const { id, warnings } = await createFitting(viewer, input);
      target = `/fittings/${id}?notice=fit-saved${warningsQuery(warnings)}`;
    }
  } catch (error) {
    return { error: userMessage(error) };
  }
  redirect(target);
}

export async function changeVisibility(fitId: string, form: FormData) {
  const visibility = String(form.get("visibility"));
  if (!(VISIBILITIES as readonly string[]).includes(visibility)) return;
  await setVisibility(await requireViewer(), fitId, visibility as Visibility);
  refresh();
}

export async function removeFit(fitId: string) {
  await deleteFitting(await requireViewer(), fitId);
  redirect("/fittings?notice=fit-deleted");
}

export async function copyFit(fitId: string, shareToken: string | null) {
  const id = await copyFitting(await requireViewer(), fitId, shareToken ?? undefined);
  redirect(`/fittings/${id}?notice=fit-copied`);
}

export async function sendFit(fitId: string, shareToken: string | null, _: FormState, form: FormData): Promise<FormState> {
  const viewer = await requireViewer();
  const characterId = Number(form.get("character"));
  try {
    await sendToGame(viewer, fitId, characterId, shareToken ?? undefined);
  } catch (error) {
    return { error: userMessage(error) };
  }
  return { ok: "Sent. It is in that character's saved fittings in game now." };
}

export async function importFits(characterId: number, form: FormData) {
  const viewer = await requireViewer();
  const ids = form.getAll("fitting").map(Number).filter(Number.isSafeInteger);
  const count = await importGameFittings(viewer, characterId, ids);
  redirect(`/fittings?notice=fits-imported&count=${count}`);
}

export type BulkState = { error?: string; results?: BulkSendResult[] };

export async function bulkSend(_: BulkState, form: FormData): Promise<BulkState> {
  const viewer = await requireViewer();
  const ids = form.getAll("fit").map(String);
  const characterId = Number(form.get("character"));
  try {
    return { results: await sendManyToGame(viewer, ids, characterId) };
  } catch (error) {
    return { error: userMessage(error) };
  }
}

export async function restoreFit(fitId: string, version: number) {
  const restored = await restoreVersion(await requireViewer(), fitId, version);
  redirect(`/fittings/${fitId}/history?restored=${version}&as=${restored}`);
}
