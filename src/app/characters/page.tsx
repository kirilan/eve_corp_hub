import type { Metadata } from "next";
import Image from "next/image";
import { Suspense } from "react";
import { Notice } from "@/components/notice";
import { SignInButton } from "@/components/sign-in-button";
import { listCharacters } from "@/lib/auth/accounts";
import { getViewer } from "@/lib/auth/viewer";
import { hasFeature } from "@/lib/eve/sso";
import { corporationLogoUrl, entityNames, portraitUrl } from "@/lib/eve/names";
import { makeMain, revokeAccess, unlink } from "./actions";

export const metadata: Metadata = { title: "Characters" };

const LINK_URL = "/auth/login?intent=link&returnTo=/characters";
const GRANT_FITTINGS_URL = "/auth/login?intent=link&feature=fittings&returnTo=/characters";

export default function CharactersPage({ searchParams }: PageProps<"/characters">) {
  return (
    <div className="space-y-6">
      <Suspense>
        <Notice searchParams={searchParams} />
      </Suspense>
      <div>
        <h1 className="text-2xl font-semibold">Characters</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Every character you log in with joins this profile, whichever EVE account it is on. Your main decides which
          corporation&apos;s shared fits you see. EVE logs in one character at a time, so add each alt separately; for
          a character on another EVE account, switch accounts in the EVE login window.
        </p>
      </div>
      <Suspense fallback={<p className="text-muted">Loading characters…</p>}>
        <CharacterList />
      </Suspense>
    </div>
  );
}

async function CharacterList() {
  const viewer = await getViewer();
  if (!viewer) {
    return <SignInButton returnTo="/characters" />;
  }
  const characters = await listCharacters(viewer.userId);
  const names = await entityNames(characters.flatMap((c) => [c.corporationId ?? 0, c.allianceId ?? 0]));

  return (
    <>
      <ul className="divide-y divide-border rounded border border-border bg-surface">
        {characters.map((character) => {
          const isMain = viewer.main?.id === character.id;
          const fittings = hasFeature(character.scopes, "fittings");
          return (
            <li key={character.id} className="flex flex-wrap items-center gap-4 p-4">
              <Image src={portraitUrl(character.id, 128)} alt="" width={48} height={48} unoptimized className="rounded" />
              <div className="min-w-48 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{character.name}</span>
                  {isMain && (
                    <span className="rounded bg-accent/15 px-1.5 py-0.5 text-xs font-medium text-accent">Main</span>
                  )}
                </div>
                <div className="mt-1 flex items-center gap-1.5 text-sm text-muted">
                  {character.corporationId && (
                    <>
                      <Image
                        src={corporationLogoUrl(character.corporationId)}
                        alt=""
                        width={16}
                        height={16}
                        unoptimized
                      />
                      <span>{names[character.corporationId] ?? `Corporation ${character.corporationId}`}</span>
                    </>
                  )}
                  {character.allianceId && <span>· {names[character.allianceId] ?? `Alliance ${character.allianceId}`}</span>}
                </div>
                <div className="mt-1 text-xs">
                  {fittings ? (
                    <span className="text-emerald-400">Fitting sync allowed</span>
                  ) : character.tokenError ? (
                    <span className="text-amber-400">Fitting access was revoked in EVE; grant it again to sync</span>
                  ) : (
                    <span className="text-muted">No fitting access</span>
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 text-sm">
                {fittings ? (
                  <form action={revokeAccess.bind(null, character.id)}>
                    <button className="rounded border border-border px-3 py-1.5 hover:border-foreground">Revoke access</button>
                  </form>
                ) : (
                  <a href={GRANT_FITTINGS_URL} className="rounded border border-border px-3 py-1.5 hover:border-accent">
                    Allow fitting sync
                  </a>
                )}
                {!isMain && (
                  <>
                    <form action={makeMain.bind(null, character.id)}>
                      <button className="rounded border border-border px-3 py-1.5 hover:border-accent">Make main</button>
                    </form>
                    <form action={unlink.bind(null, character.id)}>
                      <button className="rounded border border-border px-3 py-1.5 text-red-300 hover:border-red-400">
                        Unlink
                      </button>
                    </form>
                  </>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <a href={LINK_URL} className="inline-block rounded bg-accent px-4 py-2 font-medium text-black hover:brightness-110">
        Add a character
      </a>
    </>
  );
}
