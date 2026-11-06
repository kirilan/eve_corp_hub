import { notFound } from "next/navigation";
import { Suspense } from "react";
import { FitDetail } from "@/components/fittings/fit-detail";
import { Notice } from "@/components/notice";
import { getViewer } from "@/lib/auth/viewer";
import { viewableFitting } from "@/lib/fittings/store";

export default function FitPage({ params, searchParams }: PageProps<"/fittings/[id]">) {
  return (
    <>
      <Suspense>
        <Notice searchParams={searchParams} />
      </Suspense>
      <Suspense fallback={<p className="text-muted">Loading fit…</p>}>
        <Fit params={params} />
      </Suspense>
    </>
  );
}

async function Fit({ params }: { params: PageProps<"/fittings/[id]">["params"] }) {
  const { id } = await params;
  const viewer = await getViewer();
  // Private, foreign-corp and link-only fits all 404 here: existence is not leaked to people who cannot see them.
  const fit = await viewableFitting(viewer, id);
  if (!fit) notFound();
  return <FitDetail fit={fit} viewer={viewer} shareToken={null} />;
}
