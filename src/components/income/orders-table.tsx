"use client";

import Image from "next/image";
import { useMemo, useState } from "react";
import { formatIsk, formatIskExact } from "@/lib/income/format";

// Mirrors `OrderRow` from src/lib/orders/check.ts: what the page needs of each order, as plain data.
export type OrderView = {
  orderId: number;
  characterId: number;
  typeId: number;
  typeName: string;
  side: "buy" | "sell";
  location: string;
  region: string;
  price: number;
  volumeTotal: number;
  volumeRemain: number;
  issued: string;
  expires: string;
  range: string;
  status: string;
  note: string | null;
  bestOther: number | null;
  unitsAhead: number;
  daysAhead: number | null;
  suggest: number | null;
  bookAsOf: string | null;
};

export type OrderCharacterView = { id: number; name: string; portrait: string; color: string };

// Icon + label, never colour alone (same wording as eve-skills' dashboard).
const STATUS: Record<string, { icon: string; label: string; tone: string; rank: number }> = {
  undercut: { icon: "▼", label: "Undercut", tone: "text-red-300", rank: 0 },
  outbid: { icon: "▼", label: "Outbid", tone: "text-red-300", rank: 0 },
  "behind sliver": { icon: "•", label: "Behind sliver", tone: "text-amber-400", rank: 1 },
  unknown: { icon: "?", label: "Unchecked", tone: "text-muted", rank: 2 },
  cheapest: { icon: "✓", label: "Lowest sell", tone: "text-emerald-400", rank: 3 },
  top: { icon: "✓", label: "Highest buy", tone: "text-emerald-400", rank: 3 },
  alone: { icon: "✓", label: "Only order", tone: "text-emerald-400", rank: 3 },
};
const needsAttention = (status: string) => (STATUS[status]?.rank ?? 2) === 0;

type Side = "all" | "sell" | "buy";
type Show = "all" | "attention";

const units = (n: number) => Math.round(n).toLocaleString("en-US");

function relative(iso: string, now: number): string {
  const hours = (new Date(iso).getTime() - now) / 3_600_000;
  if (hours <= 0) return "expired";
  return hours < 48 ? `${Math.floor(hours)}h` : `${Math.floor(hours / 24)}d`;
}

function Toggle({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-sm ${active ? "border-accent text-accent" : "border-border hover:border-foreground"}`}
    >
      {children}
    </button>
  );
}

/**
 * Every open order with its standing, filterable by character, side and status without a round trip.
 * Undercut and outbid orders sort first, then by what is left on the order.
 */
export function OrdersTable({
  orders,
  characters,
  initialCharacters,
  now,
}: {
  orders: OrderView[];
  characters: OrderCharacterView[];
  initialCharacters: number[];
  now: number;
}) {
  const [picked, setPicked] = useState<number[]>(initialCharacters);
  const [side, setSide] = useState<Side>("all");
  const [show, setShow] = useState<Show>("all");
  const [search, setSearch] = useState("");
  const byId = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters]);

  const togglePicked = (id: number) =>
    setPicked((current) => {
      const next = current.includes(id) ? current.filter((c) => c !== id) : [...current, id];
      return next.length === characters.length ? [] : next;
    });

  const query = search.trim().toLowerCase();
  const shown = orders
    .filter(
      (o) =>
        (picked.length === 0 || picked.includes(o.characterId)) &&
        (side === "all" || o.side === side) &&
        (show === "all" || needsAttention(o.status)) &&
        (!query || o.typeName.toLowerCase().includes(query) || o.location.toLowerCase().includes(query)),
    )
    .sort((a, b) => (STATUS[a.status]?.rank ?? 2) - (STATUS[b.status]?.rank ?? 2) || b.price * b.volumeRemain - a.price * a.volumeRemain);
  const attention = orders.filter((o) => (picked.length === 0 || picked.includes(o.characterId)) && needsAttention(o.status)).length;
  const sellValue = shown.filter((o) => o.side === "sell").reduce((sum, o) => sum + o.price * o.volumeRemain, 0);
  const buyValue = shown.filter((o) => o.side === "buy").reduce((sum, o) => sum + o.price * o.volumeRemain, 0);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {characters.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Toggle active={picked.length === 0} onClick={() => setPicked([])}>
              All characters
            </Toggle>
            {characters.map((c) => (
              <Toggle key={c.id} active={picked.includes(c.id)} onClick={() => togglePicked(c.id)}>
                <Image src={c.portrait} alt="" width={16} height={16} unoptimized className="rounded" />
                {c.name}
              </Toggle>
            ))}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          {(["all", "sell", "buy"] as Side[]).map((s) => (
            <Toggle key={s} active={side === s} onClick={() => setSide(s)}>
              {s === "all" ? "Buy & sell" : s === "sell" ? "Sell" : "Buy"}
            </Toggle>
          ))}
        </div>
        <Toggle active={show === "attention"} onClick={() => setShow(show === "attention" ? "all" : "attention")}>
          <span className="text-red-300">▼</span> Undercut or outbid ({attention})
        </Toggle>
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Item or station"
          aria-label="Filter by item or station"
          className="w-44 rounded border border-border bg-background px-2 py-1 text-sm"
        />
      </div>
      <p className="text-xs text-muted">
        {shown.length} order{shown.length === 1 ? "" : "s"} shown · sell orders {formatIsk(sellValue)} · buy orders {formatIsk(buyValue)}
      </p>
      <div className="max-h-[36rem] overflow-auto rounded border border-border bg-surface">
        <table className="w-full text-right text-sm whitespace-nowrap tabular-nums">
          <thead className="sticky top-0 bg-surface text-xs text-muted">
            <tr className="border-b border-border">
              <th className="p-2 text-left font-normal">Status</th>
              <th className="p-2 text-left font-normal">Item</th>
              <th className="p-2 text-left font-normal">Character</th>
              <th className="p-2 text-left font-normal">Side</th>
              <th className="p-2 text-left font-normal">Where</th>
              <th className="p-2 font-normal">Price</th>
              <th className="p-2 font-normal">Left</th>
              <th className="p-2 font-normal">Best other</th>
              <th className="p-2 font-normal" title="Competing units priced ahead of this order, and how many days of the region's trade they are">
                Ahead
              </th>
              <th className="p-2 font-normal" title="One tick past the best competitor; a thin, clearly cheaper sliver of sell orders is ignored">
                Suggest
              </th>
              <th className="p-2 font-normal">Value left</th>
              <th className="p-2 font-normal">Expires</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((o) => {
              const status = STATUS[o.status] ?? STATUS.unknown;
              const filled = o.volumeTotal > 0 ? (o.volumeTotal - o.volumeRemain) / o.volumeTotal : 0;
              const character = byId.get(o.characterId);
              return (
                <tr key={o.orderId}>
                  <td className={`p-2 text-left ${status.tone}`} title={o.note ?? undefined}>
                    {status.icon} {status.label}
                  </td>
                  <td className="max-w-64 truncate p-2 text-left" title={o.typeName}>
                    {o.typeName}
                  </td>
                  <td className="p-2 text-left">
                    <span className="flex items-center gap-1.5">
                      <span className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: character?.color }} />
                      {character?.name ?? o.characterId}
                    </span>
                  </td>
                  <td className="p-2 text-left">{o.side === "sell" ? "Sell" : `Buy${o.range !== "station" ? ` (${o.range})` : ""}`}</td>
                  <td className="max-w-56 truncate p-2 text-left text-muted" title={`${o.location}, ${o.region}`}>
                    {o.location}
                  </td>
                  <td className="p-2" title={formatIskExact(o.price)}>
                    {formatIsk(o.price)}
                  </td>
                  <td className="p-2">
                    <div className="flex items-center justify-end gap-2" title={`${units(o.volumeTotal - o.volumeRemain)} of ${units(o.volumeTotal)} filled`}>
                      {units(o.volumeRemain)}/{units(o.volumeTotal)}
                      <span className="relative inline-block h-1.5 w-12 overflow-hidden rounded bg-border">
                        <span className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${(filled * 100).toFixed(1)}%` }} />
                      </span>
                    </div>
                  </td>
                  <td className="p-2">{o.bestOther === null ? "–" : formatIsk(o.bestOther)}</td>
                  <td className="p-2">
                    {o.unitsAhead > 0 ? `${units(o.unitsAhead)}${o.daysAhead !== null ? ` (${o.daysAhead.toFixed(1)}d)` : ""}` : "–"}
                  </td>
                  <td className="p-2" title={o.suggest === null ? undefined : formatIskExact(o.suggest)}>
                    {o.suggest === null ? "–" : formatIsk(o.suggest)}
                  </td>
                  <td className="p-2">{formatIsk(o.price * o.volumeRemain)}</td>
                  <td className="p-2" title={o.expires.slice(0, 16).replace("T", " ")}>
                    {relative(o.expires, now)}
                  </td>
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={12} className="p-4 text-center text-muted">
                  No open orders match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
