import Image from "next/image";
import Link from "next/link";
import { typeIconUrl } from "@/lib/eve/images";
import { portraitUrl } from "@/lib/eve/names";
import { formatIsk } from "@/lib/income/format";
import { TOP_PILOTS } from "@/lib/pvp/crawl";
import { pvpWeeks, topPvpPilots, zkillCharacterUrl, type TopPvpPilot } from "@/lib/pvp/fits";

const DAY_MS = 24 * 60 * 60 * 1000;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
/** A crawl covers the 7 days before it ran. */
const period = (crawledAt: string) => `${day(new Date(new Date(crawledAt).getTime() - 7 * DAY_MS).toISOString())} – ${day(crawledAt)}`;

/**
 * A week's top PvP pilots on zKillboard and the fits they lost: the week `?week=` names, else the
 * latest. Every crawled week can be picked. Public: shown to everyone, signed in or not.
 */
export async function TopPvpFits({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Awaited first, so this reads at request time (from the cache), never while prerendering at build.
  const { week } = await searchParams;
  const requested = typeof week === "string" && /^\d{1,15}$/.test(week) ? Number(week) : undefined;
  const [weeks, { crawl, pilots }] = await Promise.all([pvpWeeks(), topPvpPilots(requested)]);
  const withFits = pilots.filter((pilot) => pilot.fits.length > 0);
  const without = pilots.filter((pilot) => pilot.fits.length === 0);

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Top PvP pilots{crawl && <span className="text-muted"> · {period(crawl.crawledAt)}</span>}</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          The fits that the top {TOP_PILOTS} pilots of{" "}
          <a href="https://zkillboard.com/character/ranks/k/all/weekly/1/overallRank/asc/" target="_blank" rel="noreferrer" className="text-accent hover:underline">
            zKillboard&apos;s 7-day ranking
          </a>{" "}
          lost in those 7 days, read from their losses once a week. Open one to save a copy or send it to a character.
        </p>
      </div>
      {weeks.length > 1 && (
        <nav aria-label="Weeks" className="flex gap-1 overflow-x-auto pb-1">
          {weeks.map((w) => (
            <Link
              key={w.id}
              href={w.id === weeks[0].id ? "/doctrines" : `/doctrines?week=${w.id}`}
              scroll={false}
              aria-current={w.id === crawl?.id ? "page" : undefined}
              className={`shrink-0 rounded border px-2 py-1 text-xs ${
                w.id === crawl?.id ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"
              }`}
            >
              {period(w.crawledAt)}
            </Link>
          ))}
        </nav>
      )}
      {!crawl ? (
        <p className="rounded border border-dashed border-border p-6 text-sm text-muted">
          {requested === undefined ? "Nothing here yet: the first weekly crawl has not run." : "No such week."}
        </p>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-2">
            {withFits.map((pilot) => (
              <PilotCard key={pilot.characterId} pilot={pilot} />
            ))}
          </div>
          {without.length > 0 && (
            <p className="text-sm text-muted">
              No fitted losses this week: {without.map((pilot) => `#${pilot.rank} ${pilot.name}`).join(", ")}.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function PilotCard({ pilot }: { pilot: TopPvpPilot }) {
  return (
    <div className="rounded border border-border bg-surface">
      <div className="flex items-center gap-3 border-b border-border px-4 py-2">
        <span className="w-8 text-right font-mono text-sm text-muted">#{pilot.rank}</span>
        <Image src={portraitUrl(pilot.characterId, 64)} alt="" width={32} height={32} unoptimized className="rounded" />
        <a href={zkillCharacterUrl(pilot.characterId)} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate font-medium hover:underline">
          {pilot.name}
        </a>
        <span className="text-xs text-muted">
          {pilot.losses} loss{pilot.losses === 1 ? "" : "es"}
        </span>
      </div>
      <ul className="divide-y divide-border">
        {pilot.fits.map((fit) => (
          <li key={fit.killmailId}>
            <Link href={`/doctrines/top/${fit.killmailId}`} prefetch={false} className="flex items-center gap-3 px-4 py-2 hover:bg-white/5">
              <Image src={typeIconUrl(fit.shipTypeId, 64)} alt="" width={28} height={28} unoptimized className="rounded" />
              <span className="min-w-0 flex-1 truncate text-sm">{fit.shipName ?? `Type ${fit.shipTypeId}`}</span>
              {fit.losses > 1 && <span className="text-xs text-muted">lost ×{fit.losses}</span>}
              {fit.value !== null && <span className="w-16 text-right text-xs text-muted">{formatIsk(fit.value)}</span>}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
