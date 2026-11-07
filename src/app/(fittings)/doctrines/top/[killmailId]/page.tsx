import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { copyTopFit, sendTopFit } from "@/app/(fittings)/fittings/actions";
import { FitView } from "@/components/fittings/fit-view";
import { SendToGame } from "@/components/fittings/send-to-game";
import { listCharacters } from "@/lib/auth/accounts";
import { getViewer } from "@/lib/auth/viewer";
import { hasFeature } from "@/lib/eve/sso";
import { formatIsk } from "@/lib/income/format";
import { topPvpFit, zkillCharacterUrl, zkillKillUrl } from "@/lib/pvp/fits";

export default function TopPvpFitPage({ params }: PageProps<"/doctrines/top/[killmailId]">) {
  return (
    <Suspense fallback={<p className="text-muted">Loading fit…</p>}>
      <TopPvpFit params={params} />
    </Suspense>
  );
}

async function TopPvpFit({ params }: { params: PageProps<"/doctrines/top/[killmailId]">["params"] }) {
  const { killmailId } = await params;
  const id = /^\d{1,15}$/.test(killmailId) ? Number(killmailId) : 0;
  const [fit, viewer] = await Promise.all([topPvpFit(id), getViewer()]);
  if (!fit) notFound();
  const syncable = viewer ? (await listCharacters(viewer.userId)).filter((character) => hasFeature(character.scopes, "fittings")) : [];

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Link href={`/doctrines?week=${fit.crawl.id}`} className="text-sm text-accent hover:underline">
          ← Top PvP pilots, week of {fit.crawl.crawledAt.slice(0, 10)}
        </Link>
        <h1 className="text-2xl font-semibold">{fit.name}</h1>
        <p className="text-sm text-muted">
          {fit.shipName ?? `Type ${fit.shipTypeId}`} · lost by{" "}
          <a href={zkillCharacterUrl(fit.pilot.characterId)} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            {fit.pilot.name}
          </a>{" "}
          (#{fit.pilot.rank} that week) on {fit.lostAt.slice(0, 10)}
          {fit.losses > 1 && <>, {fit.losses} times that week</>}
          {fit.kills !== null && (
            <>
              {" "}
              · on {fit.kills} kill{fit.kills === 1 ? "" : "s"} in this hull that week
              {fit.iskDestroyed !== null && <> ({formatIsk(fit.iskDestroyed)} ISK destroyed)</>}
            </>
          )}
          {fit.value !== null && <> · {formatIsk(fit.value)} ISK</>} ·{" "}
          <a href={zkillKillUrl(fit.killmailId)} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            killmail on zKillboard
          </a>
        </p>
        <p className="text-xs text-muted">
          Read from the killmail: modules as fitted, drones, and the charges loaded or carried (in cargo). Other cargo is left out.
        </p>
      </div>

      <div className="grid gap-4 rounded border border-border bg-surface p-4 md:grid-cols-2">
        {viewer ? (
          <>
            <div className="space-y-2">
              <h2 className="text-sm font-medium">Send to a character</h2>
              <SendToGame send={sendTopFit.bind(null, fit.killmailId)} characters={syncable.map(({ id, name }) => ({ id, name }))} />
            </div>
            <div className="space-y-2">
              <h2 className="text-sm font-medium">Keep it</h2>
              <form action={copyTopFit.bind(null, fit.killmailId)}>
                <button className="rounded border border-border px-3 py-1.5 text-sm hover:border-accent">Save a copy to my fittings</button>
              </form>
              <p className="text-xs text-muted">A private copy you can edit, share or add to a doctrine.</p>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">
            <a href={`/auth/login?intent=login&returnTo=${encodeURIComponent(`/doctrines/top/${fit.killmailId}`)}`} className="text-accent hover:underline">
              Log in
            </a>{" "}
            to save this fit or send it to your characters.
          </p>
        )}
      </div>

      <FitView fit={fit} />
    </div>
  );
}
