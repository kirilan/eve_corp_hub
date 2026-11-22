import Link from "next/link";
import type { ReactNode } from "react";
import { type DataCell, type DataColumn, DataTable } from "@/components/data-table/data-table";
import { type ChartSeries, IncomeChart } from "@/components/income/income-chart";
import { formatBucket, formatIsk, formatIskExact, formatPlain } from "@/lib/income/format";
import type { Filters } from "@/lib/income/report";
import { type Industry, margin, type Note, NOTES, type SaleFigures } from "@/lib/trade/fifo";
import { SDE_BUILD } from "@/lib/trade/recipes";
import { type HoldingRow, type TradeReport, tradeReport } from "@/lib/trade/report";
import { setNotForTrade } from "./actions";
import { Chip, hrefWith, OTHER_COLOR, PALETTE, Tile } from "./shared";

// Categories that get their own colour in the profit chart; the rest share one.
const CHART_CATEGORIES = PALETTE.length - 1;
// Stock held this long without selling is called out.
const STALE_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const units = (n: number) => Math.round(n).toLocaleString("en-US");

function Profit({ value, exact = false }: { value: number; exact?: boolean }) {
  return (
    <span className={value > 0 ? "text-emerald-400" : value < 0 ? "text-red-300" : ""} title={formatIskExact(value)}>
      {exact ? formatIskExact(value) : formatIsk(value)}
    </span>
  );
}

function Margin({ figures }: { figures: SaleFigures }) {
  const share = margin(figures);
  return share === null ? <>–</> : <>{(share * 100).toFixed(1)}%</>;
}

/** A cost, marked when part of it is materials with no purchase on record valued at market. */
function Cost({ cost, estimated }: { cost: number; estimated: number }) {
  if (estimated <= 0.005 * cost) return <span title={formatIskExact(cost)}>{formatIsk(cost)}</span>;
  return (
    <span
      title={`${formatIskExact(cost)}, of which ${((estimated / cost) * 100).toFixed(0)}% is materials with no purchase on record, valued at EVE's average price`}
    >
      {formatIsk(cost)}
      <span className="text-amber-400">*</span>
    </span>
  );
}

/** Marks an item some of whose units a job of the profile built. */
function Built({ built, of }: { built: number; of: number }) {
  if (built <= 0) return null;
  return (
    <span className="ml-1.5 rounded bg-border px-1 py-px text-[10px] text-muted" title={`${units(built)} of ${units(of)} units were built from materials`}>
      built
    </span>
  );
}

const NOTE_TEXT: Record<Note, (n: string) => string> = {
  structureJobs: (n) =>
    `${n} manufacturing or reaction jobs ran in player structures: ESI does not report their rig and structure bonuses, so their materials are costed without them (a little high).`,
  unknownMe: (n) => `${n} jobs used a blueprint never seen in your hangars: costed at ME 0 (high).`,
  meFromSiblings: (n) => `${n} jobs used a blueprint not seen any more: costed at the ME of your other blueprints of that type.`,
  meAssumedInvented: (n) => `${n} T2 jobs used a copy not seen any more: costed at the ME an invented copy gets from its decryptor.`,
  unknownDecryptor: (n) => `${n} invention jobs made copies never seen: costed with no decryptor.`,
  ambiguousDecryptor: (n) => `${n} invention jobs could have used either of two decryptors that make the same copy: the first was assumed.`,
  missingRecipe: (n) => `${n} jobs have no recipe in the static data (SDE build ${SDE_BUILD}): nothing was costed for them.`,
  missingCopyRuns: (n) => `${n} blueprint copy runs were used that no copying or invention job on record made: they are costed at nothing.`,
  unpricedUnits: (n) => `${n} units of materials with no purchase on record and no market price are costed at nothing.`,
};

/** What the industry jobs on record add up to, and what had to be assumed to cost them. */
function IndustrySummary({ industry }: { industry: (Industry & { jobs: number }) | null }) {
  if (!industry) {
    return (
      <p className="max-w-5xl text-xs text-muted">
        Built something? Choose <em>Allow industry tracking</em> on{" "}
        <Link href="/characters" className="text-accent hover:underline">
          Characters
        </Link>{" "}
        and what a character builds is costed from the materials that went into it, through every step of the chain.
      </p>
    );
  }
  const parts = [
    `${units(industry.jobs)} industry job${industry.jobs === 1 ? "" : "s"} on record`,
    industry.inProgress.jobs > 0 && `${formatIsk(industry.inProgress.cost)} in production (${industry.inProgress.jobs} job${industry.inProgress.jobs === 1 ? "" : "s"})`,
    industry.estimated.units > 0 && `${formatIsk(industry.estimated.value)} of materials with no purchase on record, valued at market`,
    industry.lost.jobs > 0 && `${formatIsk(industry.lost.cost)} lost in ${industry.lost.jobs} cancelled job${industry.lost.jobs === 1 ? "" : "s"}`,
    industry.research.jobs > 0 && `${formatIsk(industry.research.cost)} of research fees`,
  ].filter(Boolean);
  const notes = NOTES.filter((key) => (industry.notes[key] ?? 0) > 0);
  return (
    <div className="max-w-5xl space-y-1 text-xs text-muted">
      <p>Industry: {parts.join(" · ")}.</p>
      {notes.length > 0 && (
        <details>
          <summary className="cursor-pointer hover:text-foreground">What was assumed ({notes.length})</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">
            {notes.map((key) => (
              <li key={key}>{NOTE_TEXT[key](units(industry.notes[key]!))}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** Units sold with no purchase on record, and what they sold for. */
function Unmatched({ figures }: { figures: SaleFigures }) {
  if (figures.unmatched <= 0) return <>–</>;
  return (
    <span className="text-muted" title={`${units(figures.unmatched)} units sold for ${formatIskExact(figures.unmatchedRevenue)} with no purchase on record`}>
      {units(figures.unmatched)} · {formatIsk(figures.unmatchedRevenue)}
    </span>
  );
}

/**
 * Trade performance: which trades made money and which lost it, from what each item was bought for.
 * Follows the page's range, grouping and characters, and the chart bucket being looked into.
 */
export async function Trading({ userId, filters, from, to }: { userId: string; filters: Filters; from: string; to: string }) {
  const report = await tradeReport(userId, { from, to, grouping: filters.grouping, characterIds: filters.characterIds, at: filters.at });
  const { totals, rangeTotals } = report;
  const nothing = rangeTotals.sold === 0 && report.holdings.length === 0 && report.excluded.length === 0;

  return (
    <section id="trading" className="scroll-mt-4 space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-medium">Trade performance</h2>
        {report.trackedSince && (
          <p className="max-w-5xl text-xs text-muted">Purchases on record from {report.trackedSince.toISOString().slice(0, 10)}</p>
        )}
      </div>
      {nothing ? (
        <p className="rounded border border-border bg-surface p-4 text-sm text-muted">
          No market trades in this range. Trades are read with the wallet: what a character bought and sold in the last 30
          days arrives with its next update, and every day after that is kept.
        </p>
      ) : (
        <>
          {rangeTotals.sold > 0 && <TradeChart report={report} filters={filters} />}
          <Breakdown report={report} filters={filters} totals={totals} />
          <IndustrySummary industry={report.industry} />
          <Unsold holdings={report.holdings} names={report.categoryNames} excluded={report.excluded} now={report.asOf.getTime()} />
        </>
      )}
      <p className="max-w-5xl text-xs text-muted">
        Each sale is matched to the oldest purchases or builds of the same item on any of your characters (first in,
        first out). A built item costs what its job consumed (the blueprint&apos;s recipe at its material efficiency, from
        the oldest stock of each material, built components included), the blueprint copy runs it used (with the
        invention attempts behind them, failures included) and the job&apos;s fee. Materials with no purchase on record
        are valued at EVE&apos;s average price and marked <span className="text-amber-400">*</span>. Profit is what the
        matched units sold for, less what they cost and the sales tax on them. Units with no purchase or build on record
        (loot, items bought before tracking began or moved in by contract) are counted as sales but not as profit.
        Broker fees are charged when an order is placed or changed, so they come off the total, not off any one item.
        Trades between your own characters are left out.
      </p>
    </section>
  );
}

function TradeChart({ report, filters }: { report: TradeReport; filters: Filters }) {
  // The categories that moved the most profit either way get colours; the rest are "Other".
  const weight = new Map<number, number>();
  for (const bucket of report.buckets) {
    for (const [id, amount] of [...Object.entries(bucket.gains), ...Object.entries(bucket.losses)]) {
      weight.set(Number(id), (weight.get(Number(id)) ?? 0) + amount);
    }
  }
  const ranked = [...weight].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  const named = ranked.length > CHART_CATEGORIES + 1 ? ranked.slice(0, CHART_CATEGORIES) : ranked;
  const rest = ranked.filter((id) => !named.includes(id));
  const sideSeries = (loss: boolean): ChartSeries[] => [
    ...named.map((id, i) => ({ id: `${loss ? "l" : "g"}${id}`, label: report.categoryNames[id] ?? `Category ${id}`, color: PALETTE[i], expense: loss })),
    ...(rest.length > 0 ? [{ id: loss ? "lother" : "gother", label: `${rest.length} other categories`, color: OTHER_COLOR, expense: loss }] : []),
  ];
  const hasLosses = report.buckets.some((b) => Object.keys(b.losses).length > 0);
  const series = [...sideSeries(false), ...(hasLosses ? sideSeries(true) : [])];
  const side = (amounts: Record<number, number>) => [
    ...named.map((id) => amounts[id] ?? 0),
    ...(rest.length > 0 ? [rest.reduce((sum, id) => sum + (amounts[id] ?? 0), 0)] : []),
  ];
  const buckets = report.buckets.map((b) => ({ key: b.key, values: [...side(b.gains), ...(hasLosses ? side(b.losses) : [])] }));
  const hrefs = report.buckets.map((b) => hrefWith(filters, { at: b.key === filters.at ? null : b.key }));

  return (
    <div className="space-y-3 rounded border border-border bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">Trade profit per {filters.grouping}</h3>
        <p className="max-w-5xl text-xs text-muted">Above the line, items that made money; below, items that lost it. Click a column to see its trades.</p>
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {sideSeries(false).map((s) => (
          <li key={s.id} className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </li>
        ))}
      </ul>
      <IncomeChart
        buckets={buckets}
        series={series}
        grouping={filters.grouping}
        hrefs={hrefs}
        selected={filters.at}
        labels={{ above: "Profit", below: "Losses", net: "net profit" }}
        title="Trade profit over time"
      />
    </div>
  );
}

function Breakdown({ report, filters, totals }: { report: TradeReport; filters: Filters; totals: TradeReport["totals"] }) {
  const net = totals.profit - totals.brokerFees;
  const scopeLabel = report.scope.at
    ? `${filters.grouping === "week" ? "Week of " : ""}${formatBucket(report.scope.at, filters.grouping)}${filters.grouping === "month" ? "" : ` ${report.scope.at.slice(0, 4)}`}`
    : `${report.scope.from} to ${report.scope.to}`;
  const category = filters.category;
  const items = category === null ? report.items : report.items.filter((item) => item.categoryId === category);
  const view = filters.tradeView;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{scopeLabel}</span>
        {report.scope.at && (
          <Link href={hrefWith(filters, { at: null })} scroll={false} className="text-muted hover:text-foreground">
            × whole range
          </Link>
        )}
      </div>
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Sales" value={formatIsk(totals.revenue)} detail={`${units(totals.sold)} units sold`} />
        <Tile
          label="Profit on matched sales"
          value={formatIsk(totals.profit)}
          detail={totals.matched > 0 ? `${units(totals.matched)} units, cost ${formatIsk(totals.cost)}` : "no sale matched a purchase"}
        />
        <Tile label="Broker fees" value={formatIsk(totals.brokerFees)} detail="for placing and changing orders" />
        <Tile
          label="Net trade profit"
          value={formatIsk(net)}
          detail={totals.matchedRevenue > 0 ? `${((net / totals.matchedRevenue) * 100).toFixed(1)}% of matched sales` : "after broker fees"}
        />
      </dl>
      {totals.unmatched > 0 && (
        <p className="max-w-5xl text-xs text-muted">
          {units(totals.unmatched)} units sold for {formatIsk(totals.unmatchedRevenue)} had no purchase on record: they are in
          sales but not in profit.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-sm text-muted">By</span>
        <Chip href={hrefWith(filters, { tradeView: "category", category: null })} active={view === "category"}>
          category
        </Chip>
        <Chip href={hrefWith(filters, { tradeView: "item" })} active={view === "item"}>
          item
        </Chip>
        {view === "item" && category !== null && (
          <Link href={hrefWith(filters, { category: null })} scroll={false} className="ml-2 text-sm text-muted hover:text-foreground">
            {report.categoryNames[category] ?? `Category ${category}`} ×
          </Link>
        )}
      </div>

      {view === "category" ? (
        <DataTable
          id="trade-categories"
          searchPlaceholder="Search categories"
          empty={`No sales ${report.scope.at ? "in this period" : "in this range"}.`}
          columns={[{ key: "name", label: "Category", left: true }, { key: "items", label: "Items" }, { key: "sold", label: "Sold" }, ...FIGURE_COLUMNS]}
          rows={report.categories.map((row) => ({
            key: row.categoryId,
            cells: {
              name: {
                node: (
                  <Link
                    href={hrefWith(filters, { tradeView: "item", category: row.categoryId })}
                    scroll={false}
                    className="hover:text-accent"
                    title="Show the items in this category"
                  >
                    {row.name}
                  </Link>
                ),
                sort: row.name,
                copy: row.name,
              },
              items: { node: row.items, sort: row.items, copy: String(row.items) },
              ...figureCells(row),
            },
          }))}
        />
      ) : (
        <DataTable
          id="trade-items"
          searchPlaceholder="Search items"
          empty={`No sales ${report.scope.at ? "in this period" : "in this range"}.`}
          columns={[
            { key: "name", label: "Item", left: true },
            { key: "category", label: "Category", left: true },
            { key: "sold", label: "Sold" },
            { key: "avgBuy", label: "Avg buy", title: "Average purchase price of the matched units" },
            { key: "avgSell", label: "Avg sell" },
            ...FIGURE_COLUMNS,
          ]}
          rows={items.map((row) => ({
            key: row.typeId,
            cells: {
              name: {
                node: (
                  <>
                    {row.name}
                    <Built built={row.built} of={row.matched} />
                  </>
                ),
                sort: row.name,
                copy: row.name,
                search: row.built > 0 ? "built" : undefined,
                title: row.name,
                className: "max-w-72 truncate",
              },
              category: {
                node: report.categoryNames[row.categoryId],
                sort: report.categoryNames[row.categoryId] ?? null,
                copy: report.categoryNames[row.categoryId] ?? null,
                className: "text-muted",
              },
              ...figureCells(row, true),
            },
          }))}
        />
      )}
    </div>
  );
}

const iskCell = (amount: number, node: ReactNode = formatIsk(amount)): DataCell => ({
  node,
  sort: amount,
  copy: formatPlain(amount),
  title: formatIskExact(amount),
});
const NONE: DataCell = { node: "–", sort: null };

/** The figure columns shared by the category and item views; `perUnit` adds average buy and sell. */
function figureCells(figures: SaleFigures, perUnit = false): Record<string, DataCell> {
  const matched = figures.matched > 0;
  const share = margin(figures);
  return {
    sold: { node: units(figures.sold), sort: figures.sold, copy: String(figures.sold) },
    ...(perUnit
      ? {
          avgBuy: matched ? iskCell(figures.cost / figures.matched) : NONE,
          avgSell: iskCell(figures.revenue / figures.sold),
        }
      : {}),
    sales: iskCell(figures.revenue),
    cost: matched ? { ...iskCell(figures.cost, <Cost cost={figures.cost} estimated={figures.estimated} />), title: undefined } : NONE,
    tax: figures.tax > 0 ? iskCell(figures.tax) : NONE,
    profit: matched ? { ...iskCell(figures.profit, <Profit value={figures.profit} />), title: undefined, className: "font-medium" } : NONE,
    margin: { node: <Margin figures={figures} />, sort: share, copy: share === null ? null : (share * 100).toFixed(1) },
    unmatched:
      figures.unmatched > 0
        ? { node: <Unmatched figures={figures} />, sort: figures.unmatchedRevenue, copy: String(figures.unmatched) }
        : NONE,
  };
}

const FIGURE_COLUMNS: DataColumn[] = [
  { key: "sales", label: "Sales" },
  { key: "cost", label: "Cost" },
  { key: "tax", label: "Sales tax" },
  { key: "profit", label: "Profit" },
  { key: "margin", label: "Margin" },
  { key: "unmatched", label: "No purchase on record", title: "Units sold with no purchase on record, and what they sold for" },
];

/**
 * What was bought and has not sold yet, valued at what it cost and at EVE's average price. Some of
 * it was never meant for sale (a ship, its fit): marking an item "not for trade" takes it out of
 * trade performance altogether.
 */
function Unsold({
  holdings,
  names,
  excluded,
  now,
}: {
  holdings: HoldingRow[];
  names: Record<number, string>;
  excluded: { typeId: number; name: string }[];
  now: number;
}) {
  const cost = holdings.reduce((sum, h) => sum + h.cost, 0);
  const valued = holdings.filter((h) => h.value !== null);
  const value = valued.reduce((sum, h) => sum + h.value!, 0);
  const valuedCost = valued.reduce((sum, h) => sum + h.cost, 0);
  const stale = holdings.filter((h) => now - h.oldest.getTime() >= STALE_DAYS * DAY_MS).length;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-medium">Bought or built, not sold yet</h3>
        {holdings.length > 0 && (
          <p className="text-sm text-muted">
            {holdings.length} item{holdings.length === 1 ? "" : "s"} · cost {formatIsk(cost)} · worth about {formatIsk(value)}
            {valuedCost > 0 && (
              <>
                {" "}
                (<Profit value={value - valuedCost} />)
              </>
            )}
            {stale > 0 && <span className="text-amber-400"> · {stale} held over {STALE_DAYS} days</span>}
          </p>
        )}
      </div>
      {holdings.length === 0 ? (
        <p className="text-sm text-muted">Everything bought or built in this view has sold or went into a job.</p>
      ) : (
        <DataTable
          id="trade-unsold"
          maxHeight="max-h-96"
          searchPlaceholder="Search items"
          columns={[
            { key: "name", label: "Item", left: true },
            { key: "category", label: "Category", left: true },
            { key: "units", label: "Units" },
            { key: "avgCost", label: "Avg cost" },
            { key: "cost", label: "Cost" },
            { key: "value", label: "Worth about", title: "At EVE's average price for the item" },
            { key: "unrealised", label: "Unrealised" },
            { key: "held", label: "Held since", firstDir: 1 },
            { key: "action", label: "", menuLabel: "Not for trade button", sortable: false },
          ]}
          rows={holdings.map((h) => {
            const days = Math.floor((now - h.oldest.getTime()) / DAY_MS);
            const since = h.oldest.toISOString().slice(0, 10);
            return {
              key: h.typeId,
              cells: {
                name: {
                  node: (
                    <>
                      {h.name}
                      <Built built={h.built} of={h.quantity} />
                    </>
                  ),
                  sort: h.name,
                  copy: h.name,
                  search: h.built > 0 ? "built" : undefined,
                  title: h.name,
                  className: "max-w-72 truncate",
                },
                category: { node: names[h.categoryId], sort: names[h.categoryId] ?? null, copy: names[h.categoryId] ?? null, className: "text-muted" },
                units: { node: units(h.quantity), sort: h.quantity, copy: String(h.quantity) },
                avgCost: iskCell(h.cost / h.quantity),
                cost: { ...iskCell(h.cost, <Cost cost={h.cost} estimated={h.estimated} />), title: undefined },
                value: h.value === null ? NONE : iskCell(h.value),
                unrealised: h.value === null ? NONE : { ...iskCell(h.value - h.cost, <Profit value={h.value - h.cost} />), title: undefined },
                held: {
                  node: `${since} · ${days}d`,
                  sort: h.oldest.getTime(),
                  copy: since,
                  title: `Oldest unsold unit bought ${since}`,
                  className: days >= STALE_DAYS ? "text-amber-400" : "",
                },
                action: {
                  node: (
                    <form action={setNotForTrade.bind(null, h.typeId, true)}>
                      <button className="text-xs text-muted hover:text-foreground" title="Bought to use, not to sell: leave it out of trade performance">
                        Not for trade
                      </button>
                    </form>
                  ),
                },
              },
            };
          })}
        />
      )}
      <p className="max-w-5xl text-xs text-muted">
        Only market trades and industry jobs are seen: stock that was fitted, used, reprocessed, sold by contract or lost
        still shows here.
        Mark items you bought to use as <em>Not for trade</em> to leave them out of trade performance altogether.
      </p>
      {excluded.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted hover:text-foreground">
            Not for trade ({excluded.length})
          </summary>
          <ul className="mt-2 flex flex-wrap gap-2">
            {excluded.map((item) => (
              <li key={item.typeId}>
                <form action={setNotForTrade.bind(null, item.typeId, false)} className="flex items-center gap-1.5 rounded border border-border px-2 py-1">
                  <span>{item.name}</span>
                  <button className="text-xs text-muted hover:text-accent" title="Count this item's trades again">
                    Track again
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
