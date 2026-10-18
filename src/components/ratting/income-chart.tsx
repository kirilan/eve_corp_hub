"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { formatBucket, formatIsk, formatIskExact } from "@/lib/ratting/format";

export type ChartSeries = { id: string; label: string; color: string };
export type ChartBucket = { key: string; values: number[] };

const HEIGHT = 260;
const PAD = { top: 12, right: 8, bottom: 28, left: 52 };
const MAX_BAR = 24;
const GAP = 2; // surface gap between stacked segments
const RADIUS = 4;

/** Rounds up to 1, 2, 2.5 or 5 times a power of ten, so the axis ticks read cleanly. */
function niceMax(value: number): number {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  return ([1, 2, 2.5, 5, 10].find((step) => step * power >= value) ?? 10) * power;
}

/** A column segment with its top corners rounded: the data end of the stack. */
function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

/**
 * Stacked columns of income per bucket. Each column is one hover/focus target whose tooltip
 * lists every series at that bucket; the same numbers are in the data table beside the chart.
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

  const totals = buckets.map((bucket) => bucket.values.reduce((a, b) => a + b, 0));
  const max = niceMax(Math.max(0, ...totals));
  const plotW = width - PAD.left - PAD.right;
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = plotW / Math.max(1, buckets.length);
  const barW = Math.max(1, Math.min(MAX_BAR, band * 0.7, band - 1));
  const y = (value: number) => PAD.top + plotH - (value / max) * plotH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  // Enough room per label for "Oct 18"; months need a little more.
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotW / (grouping === "month" ? 72 : 52)))));

  const tip = active === null ? null : { bucket: buckets[active], total: totals[active] };
  const tipLeft = active === null ? 0 : PAD.left + band * (active + 0.5);

  return (
    <div ref={box} className="relative w-full select-none">
      <svg width={width} height={HEIGHT} role="img" aria-label="Ratting income over time" className="block">
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
          // Bottom-up stack; only the topmost non-empty segment gets the rounded data end.
          const top = bucket.values.findLastIndex((v) => v > 0);
          let base = 0;
          return (
            <g
              key={bucket.key}
              tabIndex={0}
              aria-label={`${formatBucket(bucket.key, grouping)}: ${formatIskExact(totals[i])}`}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive((current) => (current === i ? null : current))}
              onFocus={() => setActive(i)}
              onBlur={() => setActive((current) => (current === i ? null : current))}
              className="outline-none"
            >
              {/* The hit target is the whole band, not just the painted column. */}
              <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} fill="transparent" />
              {active === i && <rect x={PAD.left + band * i} y={PAD.top} width={band} height={plotH} fill="#e3e8ef" opacity={0.05} />}
              {bucket.values.map((value, s) => {
                if (value <= 0) return null;
                const y0 = y(base);
                base += value;
                const y1 = y(base);
                // The gap comes off the segment's bottom, except for the first one on the baseline.
                const h = Math.max(0, y0 - y1 - (s > bucket.values.findIndex((v) => v > 0) ? GAP : 0));
                if (h <= 0) return null;
                return s === top ? (
                  <path key={s} d={roundedTop(x, y1, barW, h, RADIUS)} fill={series[s].color} />
                ) : (
                  <rect key={s} x={x} y={y1} width={barW} height={h} fill={series[s].color} />
                );
              })}
            </g>
          );
        })}
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
          <div className="mb-1 text-sm font-semibold tabular-nums">{formatIskExact(tip.total)}</div>
          {series.map((s, index) =>
            tip.bucket.values[index] > 0 ? (
              <div key={s.id} className="flex items-center gap-2">
                <span className="inline-block h-0.5 w-3 rounded" style={{ background: s.color }} />
                <span className="font-medium tabular-nums">{formatIsk(tip.bucket.values[index])}</span>
                <span className="text-muted">{s.label}</span>
              </div>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
