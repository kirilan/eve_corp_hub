import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { FitDetail } from "@/components/fittings/fit-detail";
import { getViewer } from "@/lib/auth/viewer";
import { fittingByShareToken } from "@/lib/fittings/store";

export const metadata: Metadata = { title: "Shared fit", robots: { index: false } };

export default function SharedFitPage({ params }: PageProps<"/s/[token]">) {
  return (
    <Suspense fallback={<p className="text-muted">Loading fit…</p>}>
      <SharedFit params={params} />
    </Suspense>
  );
}

async function SharedFit({ params }: { params: PageProps<"/s/[token]">["params"] }) {
  const { token } = await params;
  const viewer = await getViewer();
  const fit = await fittingByShareToken(viewer, token);
  if (!fit) notFound();
  return <FitDetail fit={fit} viewer={viewer} shareToken={token} />;
}
