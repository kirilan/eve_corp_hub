import type { Metadata } from "next";
import { Suspense } from "react";
import { FitForm } from "@/components/fittings/fit-form";
import { SignInButton } from "@/components/sign-in-button";
import { getViewer } from "@/lib/auth/viewer";
import { canShareWithCorporation } from "@/lib/permissions";

export const metadata: Metadata = { title: "New fit" };

export default function NewFitPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">New fit</h1>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <NewFit />
      </Suspense>
    </div>
  );
}

async function NewFit() {
  const viewer = await getViewer();
  if (!viewer) return <SignInButton returnTo="/fittings/new" />;
  return <FitForm canShareWithCorporation={canShareWithCorporation(viewer)} />;
}
