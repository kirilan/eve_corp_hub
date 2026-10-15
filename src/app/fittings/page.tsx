import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FitList } from "@/components/fittings/fit-list";
import { SearchBox } from "@/components/fittings/search-box";
import { Notice } from "@/components/notice";
import { SignInButton } from "@/components/sign-in-button";
import { getViewer } from "@/lib/auth/viewer";
import { listOwnFittings } from "@/lib/fittings/store";

export const metadata: Metadata = { title: "My fittings" };

export default function FittingsPage({ searchParams }: PageProps<"/fittings">) {
  return (
    <div className="space-y-6">
      <Suspense>
        <Notice searchParams={searchParams} />
      </Suspense>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="mr-auto text-2xl font-semibold">My fittings</h1>
        <Link href="/fittings/import" className="rounded border border-border px-3 py-1.5 text-sm hover:border-accent">
          Import from game
        </Link>
        <Link href="/fittings/new" className="rounded bg-accent px-3 py-1.5 text-sm font-medium text-black hover:brightness-110">
          New fit
        </Link>
      </div>
      <Suspense fallback={<p className="text-muted">Loading fittings…</p>}>
        <Fits searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Fits({ searchParams }: { searchParams: PageProps<"/fittings">["searchParams"] }) {
  const viewer = await getViewer();
  if (!viewer) return <SignInButton returnTo="/fittings" />;
  const { q } = await searchParams;
  const query = typeof q === "string" ? q : undefined;
  const fits = await listOwnFittings(viewer, query);
  return (
    <div className="space-y-4">
      <SearchBox defaultValue={query} />
      <FitList
        fits={fits}
        empty={query ? "No fits match that search." : "No fits yet. Paste one with New fit, or import the fits saved on your characters."}
      />
    </div>
  );
}
