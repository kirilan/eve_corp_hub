"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { formatBucket, formatIsk, formatIskExact } from "@/lib/income/format";

// Expense series hold positive amounts and stack downwards from the zero line.
export type ChartSeries = { id: string; label: string; color: string; expense?: boolean };
export type ChartBucket = { key: string; values: number[] };

const HEIGHT = 260;
const PAD = { top: 12, right: 8, bottom: 28, left: 52 };
const MAX_BAR = 24;
const GAP = 2; // surface gap between stacked segments
const RADIUS = 4;

/** Rounds up to 1, 2, 2.5 or 5 times a power of ten, so the axis ticks read cleanly. */
function nice(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 2.5, 5, 10].find((step) => step * power >= value) ?? 10) * power;
}

/** Tick values from below zero to above it, four steps or so in all, always including zero. */
function scale(up: number, down: number): number[] {
  const step = nice(Math.max(up + down, 1) / 4);
  const ticks = [];
  for (let tick = -Math.ceil(down / step) * step; tick <= Math.max(step, Math.ceil(up / step) * step); tick += step) ticks.push(tick);
  return ticks;
}

/** A column segment with the corners at its data end rounded: the top going up, the bottom going down. */
function roundedEnd(x: number, y: number, w: number, h: number, r: number, down: boolean): string {
  const rr = Math.min(r, w / 2, h);
  return down
    ? `M${x},${y}V${y + h - rr}Q${x},${y + h} ${x + rr},${y + h}H${x + w - rr}Q${x + w},${y + h} ${x + w},${y + h - rr}V${y}Z`
    : `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * Stacked columns of income per bucket, with expenses stacked below the zero line when there are
 * expense series. Each column is one hover/focus target whose tooltip lists every series at that
 * bucket; the same numbers are in the data table beside the chart.
 */
export function IncomeChart({
  buckets,
  series,
  grouping,
}: {
  buckets: ChartBucket[];
  series: ChartSeries[];
  grouping: "day" | "week" | "month";
}) {
  const box = useRef<HTMLDivElement>(null);
  // Unknown until measured in the browser; the server renders a placeholder of the chart's height.
  const [width, setWidth] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);

  useLayoutEffect(() => {
    const element = box.current;
    if (!element) return;
    const fit = (w: number) => setWidth(Math.max(280, Math.floor(w)));
    fit(element.clientWidth);
    const observer = new ResizeObserver(([entry]) => fit(entry.contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Same root element as the chart below, so React keeps the observed node when the chart replaces it.
  if (width === null) return <div ref={box} className="relative w-full select-none" style={{ height: HEIGHT }} />;

  const side = (bucket: ChartBucket, expense: boolean) =>
    bucket.values.reduce((sum, value, s) => (Boolean(series[s].expense) === expense ? sum + value : sum), 0);
  const incomes = buckets.map((bucket) => side(bucket, false));
  const costs = buckets.map((bucket) => side(bucket, true));
  const hasExpenses = series.some((s) => s.expense);
  const ticks = scale(Math.max(0, ...incomes), Math.max(0, ...costs));
  const [low, high] = [ticks[0], ticks.at(-1)!];
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / Math.max(1, buckets.length);
  const barW = Math.max(1, Math.min(MAX_BAR, band * 0.7, band - 1));
  const y = (value: number) => PAD.top + plotH - ((value - low) / (high - low)) * plotH;
  // Enough room per label for "Oct 18"; months need a little more.
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotW / (grouping === "month" ? 72 : 52)))));

  const tip = active === null ? null : { bucket: buckets[active], income: incomes[active], expenses: costs[active] };
  const tipLeft = active === null ? 0 : PAD.left + band * (active + 0.5);

  return (
    <div ref={box} className="relative w-full select-none">
      <svg width={width} height={HEIGHT} role="img" aria-label="Income over time" className="block">
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} stroke={tick === 0 ? "#383835" : "#252d3a"} strokeWidth={1} />
            <text x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">
              {formatIsk(tick)}
            </text>
          </g>
        ))}
        {buckets.map((bucket, i) => {
          const x = PAD.left + band * i + (band - barW) / 2;
          // Each side stacks away from zero; the segment furthest out gets the rounded data end, and
          // every segment but the one on the zero line gives up a gap towards it.
          const segments = (expense: boolean) => {
            const on = bucket.values.map((v, s) => (v > 0 && Boolean(series[s].expense) === expense ? s : -1)).filter((s) => s >= 0);
            let base = 0;
            return on.map((s, n) => {
              const start = base;
              base += bucket.values[s];
              const [a, b] = expense ? [y(-start), y(-base)] : [y(start), y(base)];
              const h = Math.max(0, Math.abs(b - a) - (n > 0 ? GAP : 0));
              if (h <= 0) return null;
              const top = expense ? a + (n > 0 ? GAP : 0) : b;
              return n === on.length - 1 ? (
                <path key={s} d={roundedEnd(x, top, barW, h, RADIUS, expense)} fill={series[s].color} />
              ) : (
                <rect key={s} x={x} y={top} width={barW} height={h} fill={series[s].color} />
              );
            });
          };
          return (
            <g
              key={bucket.key}
              tabIndex={0}
              aria-label={
                hasExpenses
                  ? `${formatBucket(bucket.key, grouping)}: income ${formatIskExact(incomes[i])}, expenses ${formatIskExact(costs[i])}`
                  : `${formatBucket(bucket.key, grouping)}: ${formatIskExact(incomes[i])}`
              }
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive((current) => (current === i ? null : current))}
              onFocus={() => setActive(i)}
              onBlur={() => setActive((current) => (current === i ? null : current))}
              className="outline-none"
            >
              {/* The hit target is the whole band, not just the painted column. */}
              <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} fill="transparent" />
              {active === i && <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} fill="#e3e8ef" opacity={0.05} />}
              {segments(false)}
              {segments(true)}
            </g>
          );
        })}
        {/* Drawn over the columns, so the zero line between income and expenses stays visible. */}
        {hasExpenses && <line x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} stroke="#8a94a6" strokeWidth={1} />}
        {buckets.map((bucket, i) =>
          i % labelEvery === 0 ? (
            <text
              key={bucket.key}
              x={PAD.left + band * (i + 0.5)}
              y={HEIGHT - 8}
              textAnchor="middle"
              className="fill-muted text-[11px]"
            >
              {formatBucket(bucket.key, grouping)}
            </text>
          ) : null,
        )}
      </svg>
      {tip && (
        <div
          role="tooltip"
          className="pointer-events-none absolute top-2 z-10 min-w-44 rounded border border-border bg-background/95 px-3 py-2 text-xs shadow-lg"
          style={tipLeft > width / 2 ? { right: width - tipLeft + 12 } : { left: tipLeft + 12 }}
        >
          <div className="text-muted">
            {grouping === "week" ? "Week of " : ""}
            {formatBucket(tip.bucket.key, grouping)}
          </div>
          <div className="mb-1 text-sm font-semibold tabular-nums">
            {formatIskExact(tip.income - tip.expenses)}
            {hasExpenses && <span className="font-normal text-muted"> net</span>}
          </div>
          {hasExpenses && <div className="mt-1 text-muted">Income {formatIsk(tip.income)}</div>}
          <TipLines series={series} values={tip.bucket.values} expense={false} />
          {tip.expenses > 0 && (
            <>
              <div className="mt-1 text-muted">Expenses {formatIsk(tip.expenses)}</div>
              <TipLines series={series} values={tip.bucket.values} expense />
            </>
          )}
        </div>
      )}
    </div>
  );
}

function TipLines({ series, values, expense }: { series: ChartSeries[]; values: number[]; expense: boolean }) {
  return series.map((s, index) =>
    values[index] > 0 && Boolean(s.expense) === expense ? (
      <div key={s.id} className="flex items-center gap-2">
        <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
        <span className="font-medium tabular-nums">
          {expense ? "−" : ""}
          {formatIsk(values[index])}
        </span>
        <span className="text-muted">{s.label}</span>
      </div>
    ) : null,
  );
}
