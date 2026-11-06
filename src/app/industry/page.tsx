import type { Metadata } from "next";
import { Suspense } from "react";
import { ReprocessCalculator } from "@/components/industry/reprocess-calculator";
import { SignInButton } from "@/components/sign-in-button";
import { listCharacters } from "@/lib/auth/accounts";
import { getViewer } from "@/lib/auth/viewer";
import { hasFeature } from "@/lib/eve/sso";
import { structureMarketStatus } from "@/lib/industry/market";

export const metadata: Metadata = { title: "Industry" };

export default function IndustryPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Industry</h1>
        <h2 className="mt-4 text-lg font-medium">Reprocess or sell</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Paste a list of items and choose where they are. You get three ways to turn them into ISK at that hub: sell
          them as they are, reprocess them with no skills, or reprocess them with your skills, and sell the materials
          there. Every figure is what reaches your wallet after sales tax and broker fees, and each item shows which
          way pays more for it.
        </p>
      </div>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <Calculator />
      </Suspense>
    </div>
  );
}

async function Calculator() {
  const viewer = await getViewer();
  if (!viewer) return <SignInButton returnTo="/industry" />;
  const [status, characters] = await Promise.all([structureMarketStatus("4-hwwf", viewer.userId), listCharacters(viewer.userId)]);
  // Main first: it is the likeliest pick.
  const ordered = [...characters].sort((a, b) => Number(b.id === viewer.main?.id) - Number(a.id === viewer.main?.id));
  return (
    <ReprocessCalculator
      structure={{ ...status, readAt: status.readAt?.toISOString() ?? null }}
      characters={ordered.map((c) => ({ id: c.id, name: c.name, allowsSkills: hasFeature(c.scopes, "skills") }))}
    />
  );
}
