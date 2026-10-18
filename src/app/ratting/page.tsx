import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { type ChartSeries, IncomeChart } from "@/components/ratting/income-chart";
import { SignInButton } from "@/components/sign-in-button";
import { getViewer } from "@/lib/auth/viewer";
import { entityNames, portraitUrl } from "@/lib/eve/names";
import { formatBucket, formatIsk, formatIskExact } from "@/lib/ratting/format";
import {
  type Filters,
  GROUPINGS,
  parseFilters,
  RANGES,
  type Range,
  rattingReport,
  topSystems,
  trackedCharacters,
  type TrackedCharacter,
} from "@/lib/ratting/report";
import { SOURCE_LABELS, SOURCES } from "@/lib/ratting/sources";
import { syncStaleRatting } from "@/lib/ratting/sync";
import { deleteHistory } from "./actions";

export const metadata: Metadata = { title: "Ratting" };

// Categorical slots, dark steps, in validated order (checked against the site's surface colour).
const PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const OTHER_COLOR = "#8a94a6";
const SOURCE_COLORS = { bounties: PALETTE[0], ess: PALETTE[1] };

const RANGE_LABELS: Record<Range, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", "1y": "1 year", all: "All" };

export default function RattingPage({ searchParams }: PageProps<"/ratting">) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Ratting income</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Bounties and ESS payouts across your characters, in EVE time (UTC). Figures are what reached the wallet, after
          corporation tax. EVE keeps 30 days of wallet journal, so history reaches 30 days back from when a character
          started tracking and grows from there.
        </p>
      </div>
      <Suspense fallback={<p className="text-muted">Reading wallets…</p>}>
        <Ratting searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

type Params = Awaited<PageProps<"/ratting">["searchParams"]>;

/** The page's URL with some filters changed; the rest carry over. */
function hrefWith(filters: Filters, change: Partial<Filters>): string {
  const next = { ...filters, ...change };
  const params = new URLSearchParams();
  if (next.range !== "30d") params.set("range", next.range);
  // A grouping only sticks when the range stays; a new range picks its own default.
  if ("grouping" in change || !("range" in change)) params.set("group", next.grouping);
  if (next.source !== "all") params.set("source", next.source);
  if (next.stack !== "character") params.set("stack", next.stack);
  for (const id of next.characterIds) params.append("c", String(id));
  const query = params.toString();
  return query ? `/ratting?${query}` : "/ratting";
}

function Chip({ href, active, children }: { href: string; active: boolean; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "true" : undefined}
      className={`rounded border px-2.5 py-1 text-sm ${active ? "border-accent text-accent" : "border-border hover:border-foreground"}`}
    >
      {children}
    </Link>
  );
}

/** "2026-10-18 13:05 EVE", in EVE time like everything else on the page. */
function eveTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} EVE`;
}

async function Ratting({ searchParams }: { searchParams: Promise<Params> }) {
  const viewer = await getViewer();
  if (!viewer) return <SignInButton returnTo="/ratting" />;
  // Brings stale characters up to date before reading: at most one journal read per character per hour.
  await syncStaleRatting(viewer.userId);

  const all = await trackedCharacters(viewer.userId);
  const relevant = all.filter((c) => c.tracking || c.entries > 0);
  if (relevant.length === 0) {
    return (
      <div className="max-w-2xl space-y-3 rounded border border-border bg-surface p-4 text-sm">
        <p>None of your characters track ratting income yet.</p>
        <p className="text-muted">
          On <Link href="/characters" className="text-accent hover:underline">Characters</Link>, choose{" "}
          <em>Allow ratting tracker</em> for each character you rat with. It asks EVE for read access to that
          character&apos;s wallet; only bounty and ESS payouts are kept, and only you can see them.
        </p>
      </div>
    );
  }

  const parsed = parseFilters(await searchParams);
  const own = new Set(relevant.map((c) => c.id));
  const filters: Filters = { ...parsed, characterIds: parsed.characterIds.filter((id) => own.has(id)) };
  const report = await rattingReport(viewer.userId, filters);
  const systems = await topSystems(viewer.userId, filters, report.from);
  const systemNames = await entityNames(systems.map((s) => s.solarSystemId));

  // Colour follows the character, by its place in the profile, so filtering never repaints anyone.
  const byId = new Map(relevant.map((c) => [c.id, c]));
  const slotOf = new Map(relevant.map((c, i) => [c.id, i]));
  const folds = relevant.length > PALETTE.length;
  const colorOf = (id: number) => {
    const slot = slotOf.get(id) ?? Infinity;
    return folds && slot >= PALETTE.length - 1 ? OTHER_COLOR : (PALETTE[slot] ?? OTHER_COLOR);
  };

  const shown = report.characters.map((c) => c.characterId).sort((a, b) => (slotOf.get(a) ?? 0) - (slotOf.get(b) ?? 0));
  let series: ChartSeries[];
  let values: (bucket: (typeof report.buckets)[number]) => number[];
  if (filters.stack === "source") {
    const sources = SOURCES.filter((s) => filters.source === "all" || filters.source === s);
    series = sources.map((s) => ({ id: s, label: SOURCE_LABELS[s], color: SOURCE_COLORS[s] }));
    values = (bucket) => sources.map((s) => bucket.bySource[s]);
  } else {
    const named = shown.filter((id) => colorOf(id) !== OTHER_COLOR);
    const others = shown.filter((id) => colorOf(id) === OTHER_COLOR);
    series = [
      ...named.map((id) => ({ id: String(id), label: byId.get(id)?.name ?? String(id), color: colorOf(id) })),
      ...(others.length > 0 ? [{ id: "other", label: `${others.length} other${others.length === 1 ? "" : "s"}`, color: OTHER_COLOR }] : []),
    ];
    values = (bucket) => [
      ...named.map((id) => bucket.byCharacter[id] ?? 0),
      ...(others.length > 0 ? [others.reduce((sum, id) => sum + (bucket.byCharacter[id] ?? 0), 0)] : []),
    ];
  }
  const chartBuckets = report.buckets.map((bucket) => ({ key: bucket.key, values: values(bucket) }));
  const { totals } = report;
  const historyStart = relevant
    .map((c) => c.historyFrom)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return (
    <div className="space-y-6">
      <FilterBar filters={filters} characters={relevant} colorOf={colorOf} />

      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Total income" value={formatIsk(totals.amount)} detail={`${report.from} to ${report.to}`} />
        <Tile
          label="Per active day"
          value={totals.activeDays ? formatIsk(totals.amount / totals.activeDays) : "–"}
          detail={`${totals.activeDays} day${totals.activeDays === 1 ? "" : "s"} with income`}
        />
        <Tile
          label="Best day"
          value={totals.bestDay ? formatIsk(totals.bestDay.amount) : "–"}
          detail={totals.bestDay ? formatBucket(totals.bestDay.day, "day") : "no income in range"}
        />
        <Tile
          label="Corporation tax paid"
          value={formatIsk(totals.tax)}
          detail={totals.bySource.bounties + totals.tax > 0 ? `${((totals.tax / (totals.bySource.bounties + totals.tax)) * 100).toFixed(1)}% of gross bounties` : "on bounties"}
        />
      </dl>

      <section className="space-y-3 rounded border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">
            Income per {filters.grouping}
            {filters.source !== "all" && <span className="text-muted"> · {SOURCE_LABELS[filters.source]}</span>}
          </h2>
          <div className="flex items-center gap-2 text-sm text-muted">
            Stack by
            <Chip href={hrefWith(filters, { stack: "character" })} active={filters.stack === "character"}>
              Character
            </Chip>
            <Chip href={hrefWith(filters, { stack: "source" })} active={filters.stack === "source"}>
              Source
            </Chip>
          </div>
        </div>
        {series.length > 1 && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {series.map((s) => (
              <li key={s.id} className="flex items-center gap-1.5">
                <span className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} />
                {s.label}
              </li>
            ))}
          </ul>
        )}
        {totals.amount > 0 ? (
          <IncomeChart buckets={chartBuckets} series={series} grouping={filters.grouping} />
        ) : (
          <p className="py-16 text-center text-sm text-muted">No ratting income in this range.</p>
        )}
        {historyStart && report.from < historyStart.toISOString().slice(0, 10) && (
          <p className="text-xs text-muted">
            History starts {historyStart.toISOString().slice(0, 10)}: 30 days before the first character began tracking.
          </p>
        )}
        <details className="text-sm">
          <summary className="cursor-pointer text-muted hover:text-foreground">Data table</summary>
          <div className="mt-2 max-h-80 overflow-auto">
            <table className="w-full text-right tabular-nums">
              <thead className="sticky top-0 bg-surface text-xs text-muted">
                <tr>
                  <th className="py-1 text-left font-normal">{filters.grouping === "week" ? "Week of" : filters.grouping === "month" ? "Month" : "Day"}</th>
                  {series.map((s) => (
                    <th key={s.id} className="px-2 py-1 font-normal">
                      {s.label}
                    </th>
                  ))}
                  <th className="py-1 font-normal">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {chartBuckets.map((bucket) => (
                  <tr key={bucket.key}>
                    <td className="py-1 text-left">{bucket.key}</td>
                    {bucket.values.map((value, i) => (
                      <td key={series[i].id} className="px-2 py-1">
                        {value ? formatIsk(value) : "–"}
                      </td>
                    ))}
                    <td className="py-1">{formatIsk(bucket.values.reduce((a, b) => a + b, 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      </section>

      <section className="space-y-3">
        <h2 className="font-medium">Per character</h2>
        <div className="overflow-x-auto rounded border border-border bg-surface">
          <table className="w-full min-w-[44rem] text-right text-sm tabular-nums">
            <thead className="text-xs text-muted">
              <tr className="border-b border-border">
                <th className="p-2 text-left font-normal">Character</th>
                <th className="p-2 font-normal">Total</th>
                <th className="p-2 font-normal">Share</th>
                <th className="p-2 font-normal">Bounties</th>
                <th className="p-2 font-normal">ESS</th>
                <th className="p-2 font-normal">Active days</th>
                <th className="p-2 font-normal">Per active day</th>
                <th className="p-2 font-normal" title="Estimated from bounty payouts: bounties pay every 20 minutes while ratting, so hours with a payout approximate time spent.">
                  Bounties / hour*
                </th>
                <th className="p-2 font-normal">Best day</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {report.characters.map((c) => (
                <tr key={c.characterId}>
                  <td className="p-2 text-left">
                    <Link
                      href={hrefWith(filters, { characterIds: [c.characterId] })}
                      scroll={false}
                      className="flex items-center gap-2 hover:text-accent"
                      title="Show only this character"
                    >
                      <span className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: colorOf(c.characterId) }} />
                      <Image src={portraitUrl(c.characterId, 32)} alt="" width={20} height={20} unoptimized className="rounded" />
                      {byId.get(c.characterId)?.name ?? c.characterId}
                    </Link>
                  </td>
                  <td className="p-2 font-medium" title={formatIskExact(c.amount)}>
                    {formatIsk(c.amount)}
                  </td>
                  <td className="p-2">{totals.amount > 0 ? `${((c.amount / totals.amount) * 100).toFixed(0)}%` : "–"}</td>
                  <td className="p-2">{formatIsk(c.bySource.bounties)}</td>
                  <td className="p-2">{formatIsk(c.bySource.ess)}</td>
                  <td className="p-2">{c.activeDays}</td>
                  <td className="p-2">{c.activeDays ? formatIsk(c.amount / c.activeDays) : "–"}</td>
                  <td className="p-2">{c.bountyHours ? formatIsk(c.bySource.bounties / c.bountyHours) : "–"}</td>
                  <td className="p-2">{c.bestDay ? `${formatIsk(c.bestDay.amount)} · ${formatBucket(c.bestDay.day, "day")}` : "–"}</td>
                </tr>
              ))}
              {report.characters.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-4 text-center text-muted">
                    No income from the selected characters in this range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-muted">
          * Bounties pay out every 20 minutes while you rat, so hours with at least one payout approximate time spent
          ratting. ESS payouts are left out of the hourly rate.
        </p>
      </section>

      {systems.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-medium">Top systems</h2>
          <ol className="divide-y divide-border rounded border border-border bg-surface text-sm">
            {systems.map((s) => (
              <li key={s.solarSystemId} className="flex items-center gap-3 p-2">
                <span className="min-w-0 flex-1 truncate">{systemNames[s.solarSystemId] ?? `System ${s.solarSystemId}`}</span>
                <span className="text-xs text-muted">
                  {s.characters} character{s.characters === 1 ? "" : "s"}
                </span>
                <span className="w-20 text-right font-medium tabular-nums">{formatIsk(s.amount)}</span>
              </li>
            ))}
          </ol>
          <p className="text-xs text-muted">Bounties only: ESS payouts do not say where they were earned.</p>
        </section>
      )}

      <section className="space-y-3">
        <h2 className="font-medium">Tracking</h2>
        <ul className="divide-y divide-border rounded border border-border bg-surface text-sm">
          {relevant.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 p-3">
              <span className="min-w-40 flex-1 font-medium">{c.name}</span>
              <span className="text-xs">
                {c.error ? (
                  <span className="text-amber-400">{c.error}</span>
                ) : !c.tracking ? (
                  <span className="text-muted">Not tracking; history kept</span>
                ) : c.syncedAt ? (
                  <span className="text-muted">Updated {eveTime(c.syncedAt)}</span>
                ) : (
                  <span className="text-muted">Waiting for first update</span>
                )}
              </span>
              {c.historyFrom && <span className="text-xs text-muted">History from {c.historyFrom.toISOString().slice(0, 10)}</span>}
              {c.entries > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-muted hover:text-red-300">Delete history…</summary>
                  <form action={deleteHistory.bind(null, c.id)} className="mt-2 flex items-center gap-2">
                    <span className="text-muted">
                      {c.entries} payout{c.entries === 1 ? "" : "s"}
                      {c.tracking ? "; the last 30 days come back on the next update" : ""}.
                    </span>
                    <button className="rounded border border-border px-2 py-1 text-red-300 hover:border-red-400">Delete</button>
                  </form>
                </details>
              )}
            </li>
          ))}
        </ul>
        <p className="text-xs text-muted">
          Updated when you open this page (at most hourly, as EVE refreshes wallet data hourly) and once a day for every
          tracking character. Turn tracking on or off on <Link href="/characters" className="text-accent hover:underline">Characters</Link>.
        </p>
      </section>
    </div>
  );
}

function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded border border-border bg-surface p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold">{value}</dd>
      <dd className="mt-0.5 text-xs text-muted">{detail}</dd>
    </div>
  );
}

/**
 * Range, grouping and source are links; characters are a plain GET form, so every filter works
 * without JavaScript and every view has its own URL.
 */
function FilterBar({
  filters,
  characters,
  colorOf,
}: {
  filters: Filters;
  characters: TrackedCharacter[];
  colorOf: (id: number) => string;
}) {
  const selected = (id: number) => filters.characterIds.length === 0 || filters.characterIds.includes(id);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {(Object.keys(RANGES) as Range[]).map((range) => (
            <Chip key={range} href={hrefWith(filters, { range })} active={filters.range === range}>
              {RANGE_LABELS[range]}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm text-muted">By</span>
          {GROUPINGS.map((grouping) => (
            <Chip key={grouping} href={hrefWith(filters, { grouping })} active={filters.grouping === grouping}>
              {grouping}
            </Chip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip href={hrefWith(filters, { source: "all" })} active={filters.source === "all"}>
            All income
          </Chip>
          {SOURCES.map((source) => (
            <Chip key={source} href={hrefWith(filters, { source })} active={filters.source === source}>
              {SOURCE_LABELS[source]}
            </Chip>
          ))}
        </div>
      </div>
      {characters.length > 1 && (
        <form className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          {filters.range !== "30d" && <input type="hidden" name="range" value={filters.range} />}
          <input type="hidden" name="group" value={filters.grouping} />
          {filters.source !== "all" && <input type="hidden" name="source" value={filters.source} />}
          {filters.stack !== "character" && <input type="hidden" name="stack" value={filters.stack} />}
          {characters.map((c) => (
            <label key={c.id} className="flex items-center gap-1.5">
              <input type="checkbox" name="c" value={c.id} defaultChecked={selected(c.id)} className="accent-[var(--accent)]" />
              <span className="inline-block size-2.5 rounded-sm" style={{ background: colorOf(c.id) }} />
              {c.name}
            </label>
          ))}
          <button className="rounded border border-border px-3 py-1 hover:border-accent">Apply</button>
          {filters.characterIds.length > 0 && (
            <Link href={hrefWith(filters, { characterIds: [] })} scroll={false} className="text-muted hover:text-foreground">
              All characters
            </Link>
          )}
        </form>
      )}
    </div>
  );
}
