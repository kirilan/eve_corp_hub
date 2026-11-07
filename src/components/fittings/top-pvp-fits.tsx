import Form from "next/form";
import Image from "next/image";
import Link from "next/link";
import { typeIconUrl } from "@/lib/eve/images";
import { portraitUrl } from "@/lib/eve/names";
import { formatIsk } from "@/lib/income/format";
import { TOP_PILOTS } from "@/lib/pvp/crawl";
import { isFiltering, openWeeks, parseFilter, toggleWeekHref, type PvpFilter } from "@/lib/pvp/filter";
import { pvpWeeks, SEARCH_LIMIT, searchPvpFits, topPvpPilots, zkillCharacterUrl, type PvpWeek, type TopPvpPilot } from "@/lib/pvp/fits";

const PATH = "/doctrines";
const DAY_MS = 24 * 60 * 60 * 1000;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
/** A crawl covers the 7 days before it ran. */
const period = (crawledAt: string) => `${day(new Date(new Date(crawledAt).getTime() - 7 * DAY_MS).toISOString())} – ${day(crawledAt)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

type Params = Record<string, string | string[] | undefined>;

/**
 * The top PvP pilots on zKillboard and the fits they lost, one collapsible section per crawled week (the
 * latest open; `?week=` lists the open ones), or, with `?q=` / `?min=` / `?max=`, the fits matching that
 * search across every week. Public: shown to everyone, signed in or not.
 */
export async function TopPvpFits({ searchParams }: { searchParams: Promise<Params> }) {
  // Awaited first, so this reads at request time (from the cache), never while prerendering at build.
  const params = await searchParams;
  const filter = parseFilter(params);
  const weeks = await pvpWeeks();

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold">Top PvP pilots</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          The fits that the top {TOP_PILOTS} pilots of{" "}
          <a href="https://zkillboard.com/character/ranks/k/all/weekly/1/overallRank/asc/" target="_blank" rel="noreferrer" className="text-accent hover:underline">
            zKillboard&apos;s 7-day ranking
          </a>{" "}
          lost in those 7 days, read from their losses once a week. Open one to save a copy or send it to a character.
        </p>
      </div>
      {weeks.length === 0 ? (
        <p className="rounded border border-dashed border-border p-6 text-sm text-muted">Nothing here yet: the first weekly crawl has not run.</p>
      ) : (
        <>
          <SearchForm params={params} filtering={isFiltering(filter)} />
          {isFiltering(filter) ? <SearchResults filter={filter} /> : <Weeks params={params} weeks={weeks} />}
        </>
      )}
    </section>
  );
}

function SearchForm({ params, filtering }: { params: Params; filtering: boolean }) {
  const value = (name: string) => (typeof params[name] === "string" ? params[name] : "");
  const input = "rounded border border-border bg-background px-3 py-1.5 text-sm";
  return (
    <Form action={PATH} scroll={false} className="flex flex-wrap items-end gap-2">
      <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs text-muted sm:max-w-sm">
        Ship or pilot
        <input name="q" type="search" defaultValue={value("q")} placeholder="e.g. Rifter, Ishtar or a pilot's name" className={input} />
      </label>
      <label className="flex w-28 flex-col gap-1 text-xs text-muted">
        Min ISK
        <input name="min" defaultValue={value("min")} placeholder="e.g. 50m" inputMode="decimal" className={input} />
      </label>
      <label className="flex w-28 flex-col gap-1 text-xs text-muted">
        Max ISK
        <input name="max" defaultValue={value("max")} placeholder="e.g. 1.5b" inputMode="decimal" className={input} />
      </label>
      <label className="flex w-24 flex-col gap-1 text-xs text-muted" title="Kills the pilot was on in that hull that week">
        Min kills
        <input name="kills" defaultValue={value("kills")} placeholder="e.g. 20" inputMode="numeric" className={input} />
      </label>
      <button className="rounded border border-border px-3 py-1.5 text-sm hover:border-accent">Search all weeks</button>
      {filtering && (
        <Link href={PATH} scroll={false} className="px-1 py-1.5 text-sm text-accent hover:underline">
          Clear
        </Link>
      )}
    </Form>
  );
}

/** Every week as a row that opens in place; only the open weeks' fits are read. */
async function Weeks({ params, weeks }: { params: Params; weeks: PvpWeek[] }) {
  const ids = weeks.map((week) => week.id);
  const open = openWeeks(params, ids);
  const contents = new Map(await Promise.all(open.map(async (id) => [id, await topPvpPilots(id)] as const)));

  return (
    <div className="divide-y divide-border rounded border border-border">
      {weeks.map((week, i) => {
        const shown = contents.get(week.id);
        return (
          <div key={week.id}>
            <Link
              href={toggleWeekHref(PATH, week.id, open, ids)}
              scroll={false}
              replace
              prefetch={false}
              aria-expanded={shown !== undefined}
              className="flex items-baseline gap-3 px-4 py-2.5 hover:bg-white/5"
            >
              <span aria-hidden className="w-3 text-xs text-muted">
                {shown ? "▾" : "▸"}
              </span>
              <span className="font-medium">{period(week.crawledAt)}</span>
              {i === 0 && <span className="rounded border border-accent px-1.5 text-xs text-accent">latest</span>}
              <span className="ml-auto text-xs text-muted">
                {plural(week.fits, "fit")} · {plural(week.pilots, "pilot")}
              </span>
            </Link>
            {shown && (
              <div className="space-y-3 border-t border-border p-3">
                <PilotGrid pilots={shown.pilots.filter((pilot) => pilot.fits.length > 0)} />
                {shown.pilots.some((pilot) => pilot.fits.length === 0) && (
                  <p className="text-sm text-muted">
                    No fitted losses this week:{" "}
                    {shown.pilots
                      .filter((pilot) => pilot.fits.length === 0)
                      .map((pilot) => `#${pilot.rank} ${pilot.name}`)
                      .join(", ")}
                    .
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function describe(filter: PvpFilter): string {
  const parts = [
    filter.q && `“${filter.q}”`,
    filter.minValue !== undefined && filter.maxValue !== undefined
      ? `${formatIsk(filter.minValue)}–${formatIsk(filter.maxValue)} ISK`
      : filter.minValue !== undefined
        ? `at least ${formatIsk(filter.minValue)} ISK`
        : filter.maxValue !== undefined && `at most ${formatIsk(filter.maxValue)} ISK`,
    filter.minKills !== undefined && `at least ${plural(filter.minKills, "kill")} in the hull`,
  ];
  return parts.filter(Boolean).join(", ");
}

async function SearchResults({ filter }: { filter: PvpFilter }) {
  const { weeks, fits, truncated } = await searchPvpFits(filter);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        {fits === 0
          ? `No fits match ${describe(filter)} in any week.`
          : truncated
            ? `The newest ${SEARCH_LIMIT} fits matching ${describe(filter)}; narrow the search to see older ones.`
            : `${plural(fits, "fit")} matching ${describe(filter)}, across ${plural(weeks.length, "week")}.`}
      </p>
      {weeks.map((week) => (
        <div key={week.crawl.id} className="space-y-2">
          <h3 className="text-sm font-medium">{period(week.crawl.crawledAt)}</h3>
          <PilotGrid pilots={week.pilots} />
        </div>
      ))}
    </div>
  );
}

function PilotGrid({ pilots }: { pilots: TopPvpPilot[] }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {pilots.map((pilot) => (
        <PilotCard key={pilot.characterId} pilot={pilot} />
      ))}
    </div>
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
              {fit.kills !== null && <Kills kills={fit.kills} iskDestroyed={fit.iskDestroyed} />}
              <span className="w-12 text-right text-xs text-muted" title="Times this loadout was lost that week">
                lost ×{fit.losses}
              </span>
              <span className="w-12 text-right text-xs text-muted" title="zKillboard's value of the loss">
                {fit.value !== null ? formatIsk(fit.value) : "–"}
              </span>
            </Link>
          </li>
        ))}
      </ul>
      {pilot.otherShips.length > 0 && (
        <p className="border-t border-border px-4 py-2 text-xs text-muted">
          Also killed in, never lost:{" "}
          {pilot.otherShips.map((ship, i) => (
            <span key={ship.shipTypeId} title={`${formatIsk(ship.iskDestroyed)} ISK destroyed`}>
              {i > 0 && ", "}
              {ship.shipName ?? `Type ${ship.shipTypeId}`} <span className="text-foreground">{ship.kills}</span>
            </span>
          ))}
        </p>
      )}
    </div>
  );
}

/** Kills the pilot was on in this hull that week, per zKillboard. */
function Kills({ kills, iskDestroyed }: { kills: number; iskDestroyed: number | null }) {
  return (
    <span
      className="w-16 text-right text-xs font-medium text-accent"
      title={`On ${plural(kills, "kill")} in this hull that week${iskDestroyed !== null ? `, ${formatIsk(iskDestroyed)} ISK destroyed` : ""} (zKillboard)`}
    >
      {plural(kills, "kill")}
    </span>
  );
}
