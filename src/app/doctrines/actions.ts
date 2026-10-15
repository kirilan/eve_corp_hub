"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import type { FormState } from "@/app/fittings/actions";
import type { Viewer } from "@/lib/auth/accounts";
import { getViewer } from "@/lib/auth/viewer";
import { addFitToDoctrine, createDoctrine, deleteDoctrine, removeFitFromDoctrine, updateDoctrine } from "@/lib/doctrines";
import { FittingError } from "@/lib/fittings/store";
import { z } from "zod";

async function requireViewer(): Promise<Viewer> {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  return viewer;
}

function message(error: unknown): string {
  if (error instanceof FittingError) return error.message;
  if (error instanceof z.ZodError) return error.issues[0]?.message ?? "Invalid input.";
  throw error;
}

const fields = (form: FormData) => ({ name: String(form.get("name") ?? ""), description: String(form.get("description") ?? "") });

export async function newDoctrine(_: FormState, form: FormData): Promise<FormState> {
  let id: string;
  try {
    id = await createDoctrine(await requireViewer(), fields(form));
  } catch (error) {
    return { error: message(error) };
  }
  redirect(`/doctrines/${id}`);
}

export async function editDoctrine(id: string, _: FormState, form: FormData): Promise<FormState> {
  try {
    await updateDoctrine(await requireViewer(), id, fields(form));
  } catch (error) {
    return { error: message(error) };
  }
  refresh();
  return { ok: "Saved." };
}

export async function dropDoctrine(id: string) {
  await deleteDoctrine(await requireViewer(), id);
  redirect("/doctrines");
}

export async function addToDoctrine(fittingId: string, form: FormData) {
  await addFitToDoctrine(await requireViewer(), String(form.get("doctrine")), fittingId);
  refresh();
}

export async function removeFromDoctrine(doctrineId: string, fittingId: string) {
  await removeFitFromDoctrine(await requireViewer(), doctrineId, fittingId);
  refresh();
}
