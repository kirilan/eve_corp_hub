import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { FitForm } from "@/components/fittings/fit-form";
import { getViewer } from "@/lib/auth/viewer";
import { typeNames } from "@/lib/eve/types";
import { toEft } from "@/lib/fittings/eft";
import { viewableFitting } from "@/lib/fittings/store";
import { canEditFitting, canShareWithCorporation } from "@/lib/permissions";

export const metadata: Metadata = { title: "Edit fit" };

export default function EditFitPage({ params }: PageProps<"/fittings/[id]/edit">) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Edit fit</h1>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <EditFit params={params} />
      </Suspense>
    </div>
  );
}

async function EditFit({ params }: { params: PageProps<"/fittings/[id]/edit">["params"] }) {
  const { id } = await params;
  const viewer = await getViewer();
  const fit = await viewableFitting(viewer, id);
  if (!fit || !canEditFitting(viewer, fit)) notFound();
  const names = await typeNames([fit.shipTypeId, ...fit.items.map((item) => item.type_id)]);
  return (
    <FitForm
      fitId={fit.id}
      canShareWithCorporation={canShareWithCorporation(viewer) || fit.visibility === "corporation"}
      initial={{ eft: toEft(fit, names), name: fit.name, description: fit.description, visibility: fit.visibility }}
    />
  );
}
