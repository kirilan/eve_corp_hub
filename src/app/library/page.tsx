import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { FitList } from "@/components/fittings/fit-list";
import { SearchBox } from "@/components/fittings/search-box";
import { getViewer } from "@/lib/auth/viewer";
import { entityNames } from "@/lib/eve/names";
import { listLibrary } from "@/lib/fittings/store";

export const metadata: Metadata = { title: "Library" };

export default function LibraryPage({ searchParams }: PageProps<"/library">) {
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Library</h1>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <Library searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Library({ searchParams }: { searchParams: PageProps<"/library">["searchParams"] }) {
  const { scope: rawScope, q } = await searchParams;
  const viewer = await getViewer();
  const corporationId = viewer?.main?.corporationId ?? null;
  // Corporation fits are the default for members; the public library for everyone else.
  const scope = rawScope === "public" || corporationId === null ? "public" : "corporation";
  const query = typeof q === "string" ? q : undefined;
  const fits = await listLibrary(viewer, scope, query);
  const corporationName = corporationId ? (await entityNames([corporationId]))[corporationId] : undefined;

  const tab = (value: "corporation" | "public", label: string) => (
    <Link
      href={`/library?scope=${value}`}
      className={`rounded border px-3 py-1.5 text-sm ${scope === value ? "border-accent text-accent" : "border-border hover:border-foreground"}`}
    >
      {label}
    </Link>
  );

  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-2">
        {corporationId !== null && tab("corporation", corporationName ?? "My corporation")}
        {tab("public", "Public")}
      </nav>
      <SearchBox defaultValue={query} hidden={{ scope }} />
      <FitList
        fits={fits}
        showOwner
        empty={
          query
            ? "No fits match that search."
            : scope === "corporation"
              ? "Nobody has shared a fit with your corporation yet."
              : "No public fits yet."
        }
      />
    </div>
  );
}
