import Link from "next/link";
import { type ChartSeries, IncomeChart } from "@/components/income/income-chart";
import { formatBucket, formatIsk, formatIskExact } from "@/lib/income/format";
import type { Filters } from "@/lib/income/report";
import { margin, type SaleFigures } from "@/lib/trade/fifo";
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
          <p className="text-xs text-muted">Purchases on record from {report.trackedSince.toISOString().slice(0, 10)}</p>
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
          <Unsold holdings={report.holdings} names={report.categoryNames} excluded={report.excluded} now={report.asOf.getTime()} />
        </>
      )}
      <p className="text-xs text-muted">
        Each sale is matched to the oldest purchases of the same item on any of your characters (first in, first out).
        Profit is what the matched units sold for, less what they cost and the sales tax on them. Units with no purchase
        on record (loot, things you built, items bought before tracking began or moved in by contract) are counted as
        sales but not as profit. Broker fees are charged when an order is placed or changed, so they come off the total,
        not off any one item. Trades between your own characters are left out.
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
        <p className="text-xs text-muted">Above the line, items that made money; below, items that lost it. Click a column to see its trades.</p>
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
        <p className="text-xs text-muted">
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

      <div className="max-h-[32rem] overflow-auto rounded border border-border bg-surface">
        <table className="w-full text-right text-sm whitespace-nowrap tabular-nums">
          <thead className="sticky top-0 bg-surface text-xs text-muted">
            <tr className="border-b border-border">
              <th className="p-2 text-left font-normal">{view === "category" ? "Category" : "Item"}</th>
              {view === "category" ? <th className="p-2 font-normal">Items</th> : <th className="p-2 text-left font-normal">Category</th>}
              <th className="p-2 font-normal">Sold</th>
              {view === "item" && (
                <>
                  <th className="p-2 font-normal" title="Average purchase price of the matched units">
                    Avg buy
                  </th>
                  <th className="p-2 font-normal">Avg sell</th>
                </>
              )}
              <th className="p-2 font-normal">Sales</th>
              <th className="p-2 font-normal">Cost</th>
              <th className="p-2 font-normal">Sales tax</th>
              <th className="p-2 font-normal">Profit</th>
              <th className="p-2 font-normal">Margin</th>
              <th className="p-2 font-normal" title="Units sold with no purchase on record, and what they sold for">
                No purchase on record
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {view === "category"
              ? report.categories.map((row) => (
                  <tr key={row.categoryId}>
                    <td className="p-2 text-left">
                      <Link
                        href={hrefWith(filters, { tradeView: "item", category: row.categoryId })}
                        scroll={false}
                        className="hover:text-accent"
                        title="Show the items in this category"
                      >
                        {row.name}
                      </Link>
                    </td>
                    <td className="p-2">{row.items}</td>
                    <FigureCells figures={row} />
                  </tr>
                ))
              : items.map((row) => (
                  <tr key={row.typeId}>
                    <td className="max-w-72 truncate p-2 text-left" title={row.name}>
                      {row.name}
                    </td>
                    <td className="p-2 text-left text-muted">{report.categoryNames[row.categoryId]}</td>
                    <FigureCells figures={row} perUnit />
                  </tr>
                ))}
            {(view === "category" ? report.categories.length : items.length) === 0 && (
              <tr>
                <td colSpan={12} className="p-4 text-center text-muted">
                  No sales {report.scope.at ? "in this period" : "in this range"}.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function FigureCells({ figures, perUnit = false }: { figures: SaleFigures; perUnit?: boolean }) {
  return (
    <>
      <td className="p-2">{units(figures.sold)}</td>
      {perUnit && (
        <>
          <td className="p-2">{figures.matched > 0 ? formatIsk(figures.cost / figures.matched) : "–"}</td>
          <td className="p-2">{formatIsk(figures.revenue / figures.sold)}</td>
        </>
      )}
      <td className="p-2" title={formatIskExact(figures.revenue)}>
        {formatIsk(figures.revenue)}
      </td>
      <td className="p-2">{figures.matched > 0 ? formatIsk(figures.cost) : "–"}</td>
      <td className="p-2">{figures.tax > 0 ? formatIsk(figures.tax) : "–"}</td>
      <td className="p-2 font-medium">{figures.matched > 0 ? <Profit value={figures.profit} /> : "–"}</td>
      <td className="p-2">
        <Margin figures={figures} />
      </td>
      <td className="p-2">
        <Unmatched figures={figures} />
      </td>
    </>
  );
}

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
        <h3 className="font-medium">Bought, not sold yet</h3>
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
        <p className="text-sm text-muted">Everything bought in this view has sold.</p>
      ) : (
        <div className="max-h-96 overflow-auto rounded border border-border bg-surface">
          <table className="w-full text-right text-sm whitespace-nowrap tabular-nums">
            <thead className="sticky top-0 bg-surface text-xs text-muted">
              <tr className="border-b border-border">
                <th className="p-2 text-left font-normal">Item</th>
                <th className="p-2 text-left font-normal">Category</th>
                <th className="p-2 font-normal">Units</th>
                <th className="p-2 font-normal">Avg cost</th>
                <th className="p-2 font-normal">Cost</th>
                <th className="p-2 font-normal" title="At EVE's average price for the item">
                  Worth about
                </th>
                <th className="p-2 font-normal">Unrealised</th>
                <th className="p-2 font-normal">Held since</th>
                <th className="p-2 font-normal" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {holdings.map((h) => {
                const days = Math.floor((now - h.oldest.getTime()) / DAY_MS);
                return (
                  <tr key={h.typeId}>
                    <td className="max-w-72 truncate p-2 text-left" title={h.name}>
                      {h.name}
                    </td>
                    <td className="p-2 text-left text-muted">{names[h.categoryId]}</td>
                    <td className="p-2">{units(h.quantity)}</td>
                    <td className="p-2">{formatIsk(h.cost / h.quantity)}</td>
                    <td className="p-2" title={formatIskExact(h.cost)}>
                      {formatIsk(h.cost)}
                    </td>
                    <td className="p-2">{h.value === null ? "–" : formatIsk(h.value)}</td>
                    <td className="p-2">{h.value === null ? "–" : <Profit value={h.value - h.cost} />}</td>
                    <td className={`p-2 ${days >= STALE_DAYS ? "text-amber-400" : ""}`} title={`Oldest unsold unit bought ${h.oldest.toISOString().slice(0, 10)}`}>
                      {h.oldest.toISOString().slice(0, 10)} · {days}d
                    </td>
                    <td className="p-2">
                      <form action={setNotForTrade.bind(null, h.typeId, true)}>
                        <button className="text-xs text-muted hover:text-foreground" title="Bought to use, not to sell: leave it out of trade performance">
                          Not for trade
                        </button>
                      </form>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-xs text-muted">
        Only market trades are seen: stock that was fitted, used, reprocessed, sold by contract or lost still shows here.
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
