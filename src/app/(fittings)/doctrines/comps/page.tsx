import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FleetComps } from "@/components/fittings/fleet-comps";

export const metadata: Metadata = { title: "Small-gang comps" };

export default function FleetCompsPage({ searchParams }: PageProps<"/doctrines/comps">) {
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link href="/doctrines" className="text-sm text-accent hover:underline">
          ← Doctrines
        </Link>
        <h1 className="text-2xl font-semibold">Small-gang comps</h1>
        <p className="max-w-3xl text-sm text-muted">
          What to fly with 3 to 7 pilots, and what to add as more log in: the role mixes that win fair fights outside highsec, with every ship
          at most 1B, hull and fit (or a cheaper cap you pick). Learned from zKillboard&apos;s killmails, updated daily.
        </p>
      </div>
      <Suspense fallback={<p className="text-muted">Loading comps…</p>}>
        <FleetComps searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
