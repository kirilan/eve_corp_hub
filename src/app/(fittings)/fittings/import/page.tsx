import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { typeIconUrl } from "@/lib/eve/images";
import { SignInButton } from "@/components/sign-in-button";
import { listCharacters } from "@/lib/auth/accounts";
import { ConsentMissingError } from "@/lib/auth/tokens";
import { getViewer } from "@/lib/auth/viewer";
import { hasFeature } from "@/lib/eve/sso";
import { gameFittings } from "@/lib/fittings/store";
import { importFits } from "../actions";

export const metadata: Metadata = { title: "Import from game" };

export default function ImportPage({ searchParams }: PageProps<"/fittings/import">) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Import from game</h1>
        <p className="mt-1 text-sm text-muted">
          Pick a character to see the fits saved on it in game. Imported fits start out private.
        </p>
      </div>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <Import searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

async function Import({ searchParams }: { searchParams: PageProps<"/fittings/import">["searchParams"] }) {
  const viewer = await getViewer();
  if (!viewer) return <SignInButton returnTo="/fittings/import" />;
  const syncable = (await listCharacters(viewer.userId)).filter((character) => hasFeature(character.scopes, "fittings"));
  if (syncable.length === 0) {
    return (
      <p className="text-sm">
        None of your characters allow fitting sync yet.{" "}
        <Link href="/characters" className="text-accent hover:underline">
          Allow it on the Characters page
        </Link>
        .
      </p>
    );
  }
  const { character } = await searchParams;
  const selected = syncable.find((c) => String(c.id) === character) ?? syncable[0];

  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap gap-2">
        {syncable.map((c) => (
          <Link
            key={c.id}
            href={`/fittings/import?character=${c.id}`}
            className={`rounded border px-3 py-1.5 text-sm ${c.id === selected.id ? "border-accent text-accent" : "border-border hover:border-foreground"}`}
          >
            {c.name}
          </Link>
        ))}
      </nav>
      <Suspense key={selected.id} fallback={<p className="text-muted">Asking EVE for {selected.name}&apos;s fits…</p>}>
        <GameFits characterId={selected.id} />
      </Suspense>
    </div>
  );
}

async function GameFits({ characterId }: { characterId: number }) {
  const viewer = (await getViewer())!;
  let fits;
  try {
    fits = await gameFittings(viewer, characterId);
  } catch (error) {
    if (error instanceof ConsentMissingError) {
      return <p className="text-sm text-amber-300">EVE no longer accepts this character&apos;s fitting access. Allow it again on the Characters page.</p>;
    }
    throw error;
  }
  if (fits.length === 0) return <p className="text-sm text-muted">This character has no saved fits in game.</p>;
  const fresh = fits.filter((fit) => !fit.alreadySaved).length;

  return (
    <form action={importFits.bind(null, characterId)} className="space-y-4">
      <ul className="divide-y divide-border rounded border border-border bg-surface">
        {fits.map((fit) => (
          <li key={fit.fitting_id}>
            <label className={`flex items-center gap-3 px-4 py-2.5 ${fit.alreadySaved ? "opacity-60" : "cursor-pointer hover:bg-white/5"}`}>
              <input type="checkbox" name="fitting" value={fit.fitting_id} defaultChecked={!fit.alreadySaved} disabled={fit.alreadySaved} />
              <Image src={typeIconUrl(fit.ship_type_id)} alt="" width={28} height={28} unoptimized className="rounded" />
              <span className="flex-1">
                {fit.name} <span className="text-sm text-muted">· {fit.shipName}</span>
              </span>
              {fit.alreadySaved && <span className="text-xs text-muted">already saved</span>}
            </label>
          </li>
        ))}
      </ul>
      <button disabled={fresh === 0} className="rounded bg-accent px-4 py-2 font-medium text-black hover:brightness-110 disabled:opacity-50">
        Import selected
      </button>
    </form>
  );
}
