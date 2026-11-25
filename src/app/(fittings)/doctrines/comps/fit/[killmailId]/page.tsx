import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { copyCompExampleFit, sendCompExampleFit } from "@/app/(fittings)/fittings/actions";
import { FitView } from "@/components/fittings/fit-view";
import { SendToGame } from "@/components/fittings/send-to-game";
import { listCharacters } from "@/lib/auth/accounts";
import { getViewer } from "@/lib/auth/viewer";
import { hasFeature } from "@/lib/eve/sso";
import { formatIsk } from "@/lib/income/format";
import { compFit, compFitContents } from "@/lib/pvp/comps/view";
import { zkillKillUrl } from "@/lib/pvp/fits";

export default function CompFitPage({ params }: PageProps<"/doctrines/comps/fit/[killmailId]">) {
  return (
    <Suspense fallback={<p className="text-muted">Loading fit…</p>}>
      <CompFit params={params} />
    </Suspense>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const ROLE_LABEL = { dps: "DPS", tackle: "tackle", logi: "logi", ewar: "EWAR", links: "links" } as const;

async function CompFit({ params }: { params: PageProps<"/doctrines/comps/fit/[killmailId]">["params"] }) {
  const { killmailId } = await params;
  const id = /^\d{1,15}$/.test(killmailId) ? Number(killmailId) : 0;
  const [fit, viewer] = await Promise.all([compFit(id), getViewer()]);
  if (!fit) notFound();
  const contents = compFitContents(fit);
  const syncable = viewer ? (await listCharacters(viewer.userId)).filter((character) => hasFeature(character.scopes, "fittings")) : [];
  const back = fit.month ? `/doctrines/comps?month=${fit.month}` : "/doctrines/comps";

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <Link href={back} className="text-sm text-accent hover:underline">
          ← Small-gang comps
        </Link>
        <h1 className="text-2xl font-semibold">{contents.name}</h1>
        <p className="text-sm text-muted">
          {fit.shipName ?? `Type ${fit.shipTypeId}`} · {ROLE_LABEL[fit.role]} · the loadout winning small gangs lost most in this hull
          {fit.losses !== null && fit.losses > 1 && <> ({fit.losses} times)</>}
          {fit.month && <> in {monthLabel(fit.month)}</>} · {formatIsk(fit.value)} ISK ·{" "}
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
              <SendToGame send={sendCompExampleFit.bind(null, fit.killmailId)} characters={syncable.map(({ id, name }) => ({ id, name }))} />
            </div>
            <div className="space-y-2">
              <h2 className="text-sm font-medium">Keep it</h2>
              <form action={copyCompExampleFit.bind(null, fit.killmailId)}>
                <button className="rounded border border-border px-3 py-1.5 text-sm hover:border-accent">Save a copy to my fittings</button>
              </form>
              <p className="text-xs text-muted">A private copy you can edit, share or add to a doctrine.</p>
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">
            <a href={`/auth/login?intent=login&returnTo=${encodeURIComponent(`/doctrines/comps/fit/${fit.killmailId}`)}`} className="text-accent hover:underline">
              Log in
            </a>{" "}
            to save this fit or send it to your characters.
          </p>
        )}
      </div>

      <FitView fit={contents} />
    </div>
  );
}
