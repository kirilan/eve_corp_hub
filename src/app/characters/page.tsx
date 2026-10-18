import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { Notice } from "@/components/notice";
import { SignInButton } from "@/components/sign-in-button";
import { listCharacters } from "@/lib/auth/accounts";
import { getViewer } from "@/lib/auth/viewer";
import { type Feature, featuresWith, hasFeature } from "@/lib/eve/sso";
import { corporationLogoUrl, entityNames, portraitUrl } from "@/lib/eve/names";
import { makeMain, revokeAccess, unlink } from "./actions";

export const metadata: Metadata = { title: "Characters" };

const LINK_URL = "/auth/login?intent=link&returnTo=/characters";

/** SSO for one more feature, repeating what the character already granted so the new token keeps it. */
function grantUrl(scopes: string[], feature: Feature): string {
  const params = new URLSearchParams([["intent", "link"], ...featuresWith(scopes, feature).map((f) => ["feature", f]), ["returnTo", "/characters"]]);
  return `/auth/login?${params}`;
}

const FEATURE_LABELS: Record<Feature, { on: string; off: string; grant: string }> = {
  fittings: { on: "Fitting sync allowed", off: "No fitting access", grant: "Allow fitting sync" },
  wallet: { on: "Ratting tracker allowed", off: "No wallet access", grant: "Allow ratting tracker" },
};

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
        <p className="mt-2 max-w-2xl text-sm text-muted">
          Extra access is optional and per character. <em>Fitting sync</em> reads and writes saved fittings.{" "}
          <em>Ratting tracker</em> reads the wallet journal and keeps only bounty and ESS payouts, visible to you
          alone; nothing else in the wallet is stored. Revoking access keeps the history already collected until you
          delete it on the <Link href="/ratting" className="text-accent hover:underline">Ratting</Link> page; unlinking a
          character deletes it.
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
          const granted = (Object.keys(FEATURE_LABELS) as Feature[]).filter((f) => hasFeature(character.scopes, f));
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
                <div className="mt-1 flex flex-wrap gap-x-3 text-xs">
                  {character.tokenError && granted.length === 0 ? (
                    <span className="text-amber-400">Access was revoked in EVE; grant it again to sync</span>
                  ) : (
                    (Object.keys(FEATURE_LABELS) as Feature[]).map((f) =>
                      granted.includes(f) ? (
                        <span key={f} className="text-emerald-400">
                          {FEATURE_LABELS[f].on}
                        </span>
                      ) : (
                        <span key={f} className="text-muted">
                          {FEATURE_LABELS[f].off}
                        </span>
                      ),
                    )
                  )}
                </div>
              </div>
              <div className="flex flex-wrap gap-2 text-sm">
                {(Object.keys(FEATURE_LABELS) as Feature[])
                  .filter((f) => !granted.includes(f))
                  .map((f) => (
                    <a
                      key={f}
                      href={grantUrl(character.scopes, f)}
                      className="rounded border border-border px-3 py-1.5 hover:border-accent"
                    >
                      {FEATURE_LABELS[f].grant}
                    </a>
                  ))}
                {granted.length > 0 && (
                  <form action={revokeAccess.bind(null, character.id)}>
                    <button
                      className="rounded border border-border px-3 py-1.5 hover:border-foreground"
                      title="Forgets this character's token, turning off every feature it allowed. Grant again any time."
                    >
                      Revoke access
                    </button>
                  </form>
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
