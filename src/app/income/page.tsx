import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Suspense } from "react";
import { type ChartSeries, IncomeChart } from "@/components/income/income-chart";
import { SignInButton } from "@/components/sign-in-button";
import { getViewer } from "@/lib/auth/viewer";
import { entityNames, portraitUrl } from "@/lib/eve/names";
import { formatBucket, formatIsk, formatIskExact } from "@/lib/income/format";
import {
  type Filters,
  GROUPINGS,
  incomeReport,
  parseFilters,
  RANGES,
  type Range,
  topSystems,
  trackedCharacters,
  type TrackedCharacter,
} from "@/lib/income/report";
import { type Expense, EXPENSE_LABELS, EXPENSES, RATTING, type Source, SOURCE_LABELS, SOURCES } from "@/lib/income/sources";
import { syncStaleIncome } from "@/lib/income/sync";
import { deleteHistory } from "./actions";

export const metadata: Metadata = { title: "Personal income" };

// Categorical slots, dark steps, in validated order (checked against the site's surface colour).
const PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
const OTHER_COLOR = "#8a94a6";
// Sources take the slots in their fixed order, so a source keeps its colour whatever else is filtered out.
const SOURCE_COLORS = Object.fromEntries(SOURCES.map((s, i) => [s, PALETTE[i]])) as Record<Source, string>;
// Expenses take the two slots left, taxes (the larger, nearest the zero line) in the one that stays
// apart from the blue of bounties above the line.
const EXPENSE_COLORS: Record<Expense, string> = { taxes: PALETTE[7], fees: PALETTE[6] };

const RANGE_LABELS: Record<Range, string> = { "7d": "7 days", "30d": "30 days", "90d": "90 days", "1y": "1 year", all: "All" };

export default function IncomePage({ searchParams }: PageProps<"/income">) {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Personal income</h1>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          What came into your characters&apos; wallets, in EVE time (UTC): bounties and ESS payouts, mission rewards,
          market and contract sales, and other rewards. ISK moved between characters is not income and is left out. EVE
          keeps 30 days of wallet journal, so history reaches 30 days back from when a character started tracking and
          grows from there.
        </p>
      </div>
      <Suspense fallback={<p className="text-muted">Reading wallets…</p>}>
        <Income searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

type Params = Awaited<PageProps<"/income">["searchParams"]>;

/** The sources a filter shows: the ones picked, or all of them when none are. */
const shownSources = (filters: Filters): readonly Source[] => (filters.sources.length > 0 ? filters.sources : SOURCES);

/**
 * Clicking a source while every source shows narrows to it; after that, clicks add and remove.
 * Removing the last one, or adding the last missing one, is back to every source.
 */
function toggleSource(current: Source[], source: Source): Source[] {
  if (current.length === 0) return [source];
  const next = current.includes(source) ? current.filter((s) => s !== source) : [...current, source];
  return next.length === SOURCES.length ? [] : SOURCES.filter((s) => next.includes(s));
}

/** The page's URL with some filters changed; the rest carry over. */
function hrefWith(filters: Filters, change: Partial<Filters>): string {
  const next = { ...filters, ...change };
  const params = new URLSearchParams();
  if (next.range !== "30d") params.set("range", next.range);
  // A grouping only sticks when the range stays; a new range picks its own default.
  if ("grouping" in change || !("range" in change)) params.set("group", next.grouping);
  for (const source of next.sources) params.append("s", source);
  if (next.stack !== "character") params.set("stack", next.stack);
  if (next.expenses) params.set("exp", "1");
  for (const id of next.characterIds) params.append("c", String(id));
  const query = params.toString();
  return query ? `/income?${query}` : "/income";
}

function Chip({ href, active, swatch, children }: { href: string; active: boolean; swatch?: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "true" : undefined}
      className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-sm ${active ? "border-accent text-accent" : "border-border hover:border-foreground"}`}
    >
      {swatch && <span className="inline-block size-2.5 rounded-sm" style={{ background: swatch }} />}
      {children}
    </Link>
  );
}

/** "2026-10-18 13:05 EVE", in EVE time like everything else on the page. */
function eveTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} EVE`;
}

async function Income({ searchParams }: { searchParams: Promise<Params> }) {
  const viewer = await getViewer();
  if (!viewer) return <SignInButton returnTo="/income" />;
  // Brings stale characters up to date before reading: at most one journal read per character per hour.
  await syncStaleIncome(viewer.userId);

  const all = await trackedCharacters(viewer.userId);
  const relevant = all.filter((c) => c.tracking || c.entries > 0);
  if (relevant.length === 0) {
    return (
      <div className="max-w-2xl space-y-3 rounded border border-border bg-surface p-4 text-sm">
        <p>None of your characters track income yet.</p>
        <p className="text-muted">
          On <Link href="/characters" className="text-accent hover:underline">Characters</Link>, choose{" "}
          <em>Allow income tracker</em> for each character you want to follow. It asks EVE for read access to that
          character&apos;s wallet; only income and the taxes and fees on it are kept, and only you can see them.
        </p>
      </div>
    );
  }

  const parsed = parseFilters(await searchParams);
  const own = new Set(relevant.map((c) => c.id));
  const filters: Filters = { ...parsed, characterIds: parsed.characterIds.filter((id) => own.has(id)) };
  const report = await incomeReport(viewer.userId, filters);
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
  const { totals } = report;
  // Sources with income in view; the rest would only add empty legend entries and table columns.
  const earning = shownSources(filters).filter((s) => totals.bySource[s] > 0);
  const spent = filters.expenses && totals.expenses > 0;
  if (filters.stack === "source") {
    const sources = earning.length > 0 ? earning : shownSources(filters);
    const charges = spent ? EXPENSES.filter((e) => totals.byExpense[e] > 0) : [];
    series = [
      ...sources.map((s) => ({ id: s, label: SOURCE_LABELS[s], color: SOURCE_COLORS[s] })),
      ...charges.map((e) => ({ id: e, label: EXPENSE_LABELS[e], color: EXPENSE_COLORS[e], expense: true })),
    ];
    values = (bucket) => [...sources.map((s) => bucket.bySource[s]), ...charges.map((e) => bucket.byExpense[e])];
  } else {
    const named = shown.filter((id) => colorOf(id) !== OTHER_COLOR);
    const others = shown.filter((id) => colorOf(id) === OTHER_COLOR);
    const characterSeries = (expense: boolean) => [
      ...named.map((id) => ({ id: `${expense ? "x" : ""}${id}`, label: byId.get(id)?.name ?? String(id), color: colorOf(id), expense })),
      ...(others.length > 0
        ? [{ id: expense ? "xother" : "other", label: `${others.length} other${others.length === 1 ? "" : "s"}`, color: OTHER_COLOR, expense }]
        : []),
    ];
    // Below the line, each character's expenses in its own colour.
    const characterValues = (perCharacter: Record<number, number>) => [
      ...named.map((id) => perCharacter[id] ?? 0),
      ...(others.length > 0 ? [others.reduce((sum, id) => sum + (perCharacter[id] ?? 0), 0)] : []),
    ];
    series = [...characterSeries(false), ...(spent ? characterSeries(true) : [])];
    values = (bucket) => [...characterValues(bucket.byCharacter), ...(spent ? characterValues(bucket.expensesByCharacter) : [])];
  }
  const chartBuckets = report.buckets.map((bucket) => ({ key: bucket.key, values: values(bucket) }));
  const net = totals.amount - totals.expenses;
  const charges = Object.entries(totals.byCharge).sort(([, a], [, b]) => b - a);
  const ratting = earning.includes("bounties");
  const historyStart = relevant
    .map((c) => c.historyFrom)
    .filter((d): d is Date => d !== null)
    .sort((a, b) => a.getTime() - b.getTime())[0];

  return (
    <div className="space-y-6">
      <FilterBar filters={filters} characters={relevant} colorOf={colorOf} />

      {filters.expenses ? (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Income before tax" value={formatIsk(totals.amount)} detail={`${report.from} to ${report.to}`} />
          <Tile
            label="Taxes and fees"
            value={formatIsk(totals.expenses)}
            detail={totals.amount > 0 ? `${((totals.expenses / totals.amount) * 100).toFixed(1)}% of income` : "no income in range"}
          />
          <Tile label="Net income" value={formatIsk(net)} detail="what the wallets kept" />
          <Tile
            label="Net per active day"
            value={totals.activeDays ? formatIsk(net / totals.activeDays) : "–"}
            detail={`${totals.activeDays} day${totals.activeDays === 1 ? "" : "s"} with income`}
          />
        </dl>
      ) : (
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
            detail={totals.taxedGross > 0 ? `${((totals.tax / totals.taxedGross) * 100).toFixed(1)}% of taxed payouts` : "none withheld"}
          />
        </dl>
      )}

      <section className="space-y-3 rounded border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-medium">
            {filters.expenses ? "Income and expenses" : "Income"} per {filters.grouping}
            {filters.sources.length > 0 && <span className="text-muted"> · {filters.sources.map((s) => SOURCE_LABELS[s]).join(", ")}</span>}
          </h2>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <Chip href={hrefWith(filters, { expenses: !filters.expenses })} active={filters.expenses}>
              {filters.expenses ? "✓ " : ""}Taxes &amp; fees
            </Chip>
            <span className="mx-1 h-5 w-px bg-border" aria-hidden />
            Stack by
            <Chip href={hrefWith(filters, { stack: "character" })} active={filters.stack === "character"}>
              Character
            </Chip>
            <Chip href={hrefWith(filters, { stack: "source" })} active={filters.stack === "source"}>
              Source
            </Chip>
          </div>
        </div>
        {(series.length > 1 || spent) && (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
            {/* By character, the same colours repeat below the line: list each character once. */}
            {series
              .filter((s) => filters.stack === "source" || !s.expense)
              .map((s) => (
                <li key={s.id} className="flex items-center gap-1.5">
                  <span className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} />
                  {s.label}
                </li>
              ))}
            {spent && <li className="text-muted">Below the line: {filters.stack === "source" ? "expenses" : "each character's taxes and fees"}</li>}
          </ul>
        )}
        {totals.amount > 0 ? (
          <IncomeChart buckets={chartBuckets} series={series} grouping={filters.grouping} />
        ) : (
          <p className="py-16 text-center text-sm text-muted">No income in this range.</p>
        )}
        {(earning.includes("market") || earning.includes("contracts")) && (
          <p className="text-xs text-muted">
            {filters.expenses
              ? "Market and contract sales are what buyers paid, with sales tax and broker fees below the line. What you bought is not subtracted, so net market income is turnover after fees, not profit."
              : "Market and contract sales are what buyers paid: sales tax, broker fees and your own purchases are not subtracted, so they show turnover rather than profit."}
          </p>
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
                      {s.expense && filters.stack === "character" ? " (expenses)" : ""}
                    </th>
                  ))}
                  <th className="py-1 font-normal">{spent ? "Net" : "Total"}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {chartBuckets.map((bucket) => (
                  <tr key={bucket.key}>
                    <td className="py-1 text-left">{bucket.key}</td>
                    {bucket.values.map((value, i) => (
                      <td key={series[i].id} className="px-2 py-1">
                        {value ? formatIsk(series[i].expense ? -value : value) : "–"}
                      </td>
                    ))}
                    <td className="py-1">{formatIsk(bucket.values.reduce((sum, value, i) => sum + (series[i].expense ? -value : value), 0))}</td>
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
          <table className="w-full text-right text-sm whitespace-nowrap tabular-nums">
            <thead className="text-xs text-muted">
              <tr className="border-b border-border">
                <th className="p-2 text-left font-normal">Character</th>
                <th className="p-2 font-normal">{filters.expenses ? "Income" : "Total"}</th>
                <th className="p-2 font-normal">Share</th>
                {filters.expenses && (
                  <>
                    <th className="p-2 font-normal">Taxes &amp; fees</th>
                    <th className="p-2 font-normal">Net</th>
                  </>
                )}
                {earning.map((s) => (
                  <th key={s} className="p-2 font-normal">
                    {SOURCE_LABELS[s]}
                  </th>
                ))}
                <th className="p-2 font-normal">Active days</th>
                <th className="p-2 font-normal">Per active day</th>
                {ratting && (
                  <th className="p-2 font-normal" title="Estimated from bounty payouts: bounties pay every 20 minutes while ratting, so hours with a payout approximate time spent.">
                    Bounties / hour*
                  </th>
                )}
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
                      <Image src={portraitUrl(c.characterId, 32)} alt="" width={20} height={20} unoptimized className="shrink-0 rounded" />
                      {byId.get(c.characterId)?.name ?? c.characterId}
                    </Link>
                  </td>
                  <td className="p-2 font-medium" title={formatIskExact(c.amount)}>
                    {formatIsk(c.amount)}
                  </td>
                  <td className="p-2">{totals.amount > 0 ? `${((c.amount / totals.amount) * 100).toFixed(0)}%` : "–"}</td>
                  {filters.expenses && (
                    <>
                      <td className="p-2">{c.expenses ? formatIsk(-c.expenses) : "–"}</td>
                      <td className="p-2 font-medium">{formatIsk(c.amount - c.expenses)}</td>
                    </>
                  )}
                  {earning.map((s) => (
                    <td key={s} className="p-2">
                      {c.bySource[s] ? formatIsk(c.bySource[s]) : "–"}
                    </td>
                  ))}
                  <td className="p-2">{c.activeDays}</td>
                  <td className="p-2">{c.activeDays ? formatIsk(c.amount / c.activeDays) : "–"}</td>
                  {ratting && <td className="p-2">{c.bountyHours ? formatIsk(c.bySource.bounties / c.bountyHours) : "–"}</td>}
                  <td className="p-2">{c.bestDay ? `${formatIsk(c.bestDay.amount)} · ${formatBucket(c.bestDay.day, "day")}` : "–"}</td>
                </tr>
              ))}
              {report.characters.length === 0 && (
                <tr>
                  <td colSpan={6 + earning.length + (ratting ? 1 : 0) + (filters.expenses ? 2 : 0)} className="p-4 text-center text-muted">
                    No income from the selected characters in this range.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {ratting && (
          <p className="text-xs text-muted">
            * Bounties pay out every 20 minutes while you rat, so hours with at least one payout approximate time spent
            ratting. Only bounties count towards the hourly rate.
          </p>
        )}
      </section>

      {spent && (
        <section className="space-y-3">
          <h2 className="font-medium">Taxes and fees</h2>
          <ul className="divide-y divide-border rounded border border-border bg-surface text-sm">
            {charges.map(([label, amount]) => (
              <li key={label} className="flex items-center gap-3 p-2">
                <span className="min-w-0 flex-1 truncate">{label}</span>
                {totals.amount > 0 && <span className="text-xs text-muted">{((amount / totals.amount) * 100).toFixed(1)}% of income</span>}
                <span className="w-20 text-right font-medium tabular-nums" title={formatIskExact(amount)}>
                  {formatIsk(amount)}
                </span>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">
            Corporation tax is withheld from bounties, missions and rewards before they reach the wallet. Broker fees
            are charged when an order is placed or changed, whether or not it sells. Industry and planetary costs are
            not tracked.
          </p>
        </section>
      )}

      {systems.length > 0 && (
        <section className="space-y-3">
          <h2 className="font-medium">Top ratting systems</h2>
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
          <p className="text-xs text-muted">Bounties only: other income does not say where it was earned.</p>
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
                      {c.entries} journal line{c.entries === 1 ? "" : "s"}
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
 * Range, grouping and sources are links; characters are a plain GET form, so every filter works
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
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip href={hrefWith(filters, { sources: [] })} active={filters.sources.length === 0}>
          All income
        </Chip>
        <Chip
          href={hrefWith(filters, { sources: [...RATTING] })}
          active={filters.sources.length === RATTING.length && RATTING.every((s) => filters.sources.includes(s))}
        >
          Ratting
        </Chip>
        <span className="mx-1 h-5 w-px bg-border" aria-hidden />
        {SOURCES.map((source) => (
          <Chip
            key={source}
            href={hrefWith(filters, { sources: toggleSource(filters.sources, source) })}
            active={filters.sources.includes(source)}
            swatch={filters.stack === "source" ? SOURCE_COLORS[source] : undefined}
          >
            {SOURCE_LABELS[source]}
          </Chip>
        ))}
      </div>
      {characters.length > 1 && (
        <form className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          {filters.range !== "30d" && <input type="hidden" name="range" value={filters.range} />}
          <input type="hidden" name="group" value={filters.grouping} />
          {filters.sources.map((source) => (
            <input key={source} type="hidden" name="s" value={source} />
          ))}
          {filters.stack !== "character" && <input type="hidden" name="stack" value={filters.stack} />}
          {filters.expenses && <input type="hidden" name="exp" value="1" />}
          {characters.map((c) => (
            <label key={c.id} className="flex items-center gap-1.5">
              <input type="checkbox" name="c" value={c.id} defaultChecked={selected(c.id)} className="accent-[var(--accent)]" />
              {filters.stack === "character" && <span className="inline-block size-2.5 rounded-sm" style={{ background: colorOf(c.id) }} />}
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
