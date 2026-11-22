"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { syncOpenOrders } from "@/app/income/actions";
import { type DataColumn, DataTable, type DataRow } from "@/components/data-table/data-table";
import { formatIsk, formatIskExact, formatPlain } from "@/lib/income/format";

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
  corp: { units: number; holdsBest: boolean } | null;
};

export type OrderCharacterView = { id: number; name: string; portrait: string; color: string };

// Mirrors `OrdersReport` from src/lib/orders/check.ts.
export type OrdersReportView = {
  characters: { id: number; name: string; allowed: boolean; sharing: boolean; error: string | null; orders: number }[];
  orders: OrderView[];
  warnings: string[];
  checkedAt: number;
};

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

const eveTime = (date: Date) => `${date.toISOString().slice(0, 16).replace("T", " ")} EVE`;

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
 * Open orders with a Sync now button: the server renders the first report, and syncing swaps in a new
 * one (orders read from EVE again, books re-read when over a minute old) without rendering the page.
 */
export function OrdersPanel({
  initial,
  colors,
  initialCharacters,
}: {
  initial: OrdersReportView;
  colors: Record<number, string>;
  initialCharacters: number[];
}) {
  const [report, setReport] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const sync = () =>
    startTransition(async () => {
      try {
        setReport(await syncOpenOrders());
        setError(null);
      } catch (e) {
        console.error(e);
        setError("Could not sync orders. Try again in a moment.");
      }
    });

  const allowed = report.characters.filter((c) => c.allowed);
  const failing = report.characters.filter((c) => c.error);
  const withOrders = allowed.filter((c) => c.orders > 0);
  const sharing = allowed.some((c) => c.sharing);
  const oldestBook = report.orders
    .map((o) => o.bookAsOf)
    .filter((d): d is string => d !== null)
    .sort()[0];
  const characters = withOrders.map((c) => ({
    id: c.id,
    name: c.name,
    portrait: `https://images.evetech.net/characters/${c.id}/portrait?size=32`,
    color: colors[c.id] ?? "#8a94a6",
  }));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <button
          type="button"
          onClick={sync}
          disabled={pending}
          className="rounded border border-accent px-3 py-1.5 font-medium text-accent hover:bg-accent/10 disabled:cursor-wait disabled:opacity-60"
          title="Read your orders from EVE again, and the order books they sit in"
        >
          {pending ? "Syncing…" : "Sync now"}
        </button>
        <span className="text-xs text-muted">Checked {eveTime(new Date(report.checkedAt))}</span>
        {error && <span className="text-xs text-red-300">{error}</span>}
      </div>
      {failing.map((c) => (
        <p key={c.id} className="text-sm text-amber-400">
          {c.name}: {c.error}
        </p>
      ))}
      {report.warnings.map((warning) => (
        <p key={warning} className="text-sm text-amber-400">
          {warning}
        </p>
      ))}
      {report.orders.length === 0 ? (
        <p className="rounded border border-border bg-surface p-4 text-sm text-muted">No open orders.</p>
      ) : (
        <OrdersTable
          orders={report.orders}
          characters={characters}
          initialCharacters={initialCharacters.filter((id) => withOrders.some((c) => c.id === id))}
          now={report.checkedAt}
          showCorp={sharing}
        />
      )}
      <p className="max-w-5xl text-xs text-muted">
        Each order is compared with the other orders on its side of its station&apos;s book; your own orders never count
        as competition. Buy orders are compared at their station only, whatever their range. Books are at most 5 minutes
        old at stations and 15 minutes in player structures; <em>Sync now</em> re-reads those over a minute old (5 for
        structures, as often as EVE updates them)
        {oldestBook ? ` (oldest used: ${eveTime(new Date(oldestBook))})` : ""}; a structure&apos;s market needs a character of
        yours that can dock there to allow market reading. EVE refreshes a character&apos;s order list every 20 minutes,
        so a new or changed order can take that long to show, however often you sync.{" "}
        {sharing ? (
          <>
            <em>Corp</em> marks orders where a member of the character&apos;s corporation who also shares their orders is
            priced ahead of you; it never says who. Their orders are at most 20 minutes old, and count only while the live
            book still shows them.
          </>
        ) : (
          <>
            To see when a corp member is the one undercutting or outbidding you, choose <em>Share orders with corp</em> on{" "}
            <Link href="/characters" className="text-accent hover:underline">
              Characters
            </Link>
            ; it works with corp members who share theirs.
          </>
        )}
        {allowed.length < report.characters.length && (
          <>
            {" "}
            {report.characters.length - allowed.length} of your characters do not allow order tracking (
            <Link href="/characters" className="text-accent hover:underline">
              Characters
            </Link>
            ).
          </>
        )}
      </p>
    </div>
  );
}

const COLUMNS: DataColumn[] = [
  { key: "status", label: "Status", left: true },
  { key: "corp", label: "Corp", left: true, title: "A member of this character's corporation, sharing their orders too, is priced ahead of this order" },
  { key: "item", label: "Item", left: true },
  { key: "character", label: "Character", left: true },
  { key: "side", label: "Side", left: true },
  { key: "where", label: "Where", left: true },
  { key: "price", label: "Price" },
  { key: "left", label: "Left" },
  { key: "bestOther", label: "Best other" },
  { key: "ahead", label: "Ahead", title: "Competing units priced ahead of this order, and how many days of the region's trade they are" },
  { key: "suggest", label: "Suggest", title: "One tick past the best competitor; a thin, clearly cheaper sliver of sell orders is ignored" },
  { key: "value", label: "Value left" },
  { key: "expires", label: "Expires", firstDir: 1 },
];

const statusRank = (o: OrderView) => STATUS[o.status]?.rank ?? 2;
const value = (o: OrderView) => o.price * o.volumeRemain;

function orderRow(o: OrderView, character: OrderCharacterView | undefined, now: number): DataRow<OrderView> {
  const status = STATUS[o.status] ?? STATUS.unknown;
  const filled = o.volumeTotal > 0 ? (o.volumeTotal - o.volumeRemain) / o.volumeTotal : 0;
  const expires = o.expires.slice(0, 16).replace("T", " ");
  return {
    key: o.orderId,
    data: o,
    cells: {
      status: {
        node: (
          <span className={status.tone}>
            {status.icon} {status.label}
          </span>
        ),
        sort: statusRank(o),
        copy: status.label,
        title: o.note ?? undefined,
      },
      corp: {
        node: o.corp ? <span className="text-amber-400">⚑ Corp member{o.corp.holdsBest ? " (best)" : ""}</span> : <span className="text-muted">–</span>,
        sort: o.corp ? o.corp.units + (o.corp.holdsBest ? 1e15 : 0) : null,
        copy: o.corp ? "Corp member" : null,
        title: o.corp
          ? `${units(o.corp.units)} units from corp members are priced ahead of this order${o.corp.holdsBest ? ", including the best price" : ""}`
          : undefined,
      },
      item: { node: o.typeName, sort: o.typeName, copy: o.typeName, title: o.typeName, className: "max-w-64 truncate" },
      character: {
        node: (
          <span className="flex items-center gap-1.5">
            <span className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: character?.color }} />
            {character?.name ?? o.characterId}
          </span>
        ),
        sort: character?.name ?? String(o.characterId),
        copy: character?.name ?? String(o.characterId),
      },
      side: {
        node: o.side === "sell" ? "Sell" : `Buy${o.range !== "station" ? ` (${o.range})` : ""}`,
        sort: o.side,
        copy: o.side === "sell" ? "Sell" : "Buy",
      },
      where: {
        node: o.location,
        sort: o.location,
        copy: o.location,
        search: o.region,
        title: `${o.location}, ${o.region}`,
        className: "max-w-56 truncate text-muted",
      },
      price: { node: formatIsk(o.price), sort: o.price, copy: formatPlain(o.price), title: formatIskExact(o.price) },
      left: {
        node: (
          <div className="flex items-center justify-end gap-2">
            {units(o.volumeRemain)}/{units(o.volumeTotal)}
            <span className="relative inline-block h-1.5 w-12 overflow-hidden rounded bg-border">
              <span className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${(filled * 100).toFixed(1)}%` }} />
            </span>
          </div>
        ),
        sort: o.volumeRemain,
        copy: String(o.volumeRemain),
        title: `${units(o.volumeTotal - o.volumeRemain)} of ${units(o.volumeTotal)} filled`,
      },
      bestOther: {
        node: o.bestOther === null ? "–" : formatIsk(o.bestOther),
        sort: o.bestOther,
        copy: o.bestOther === null ? null : formatPlain(o.bestOther),
      },
      ahead: {
        node: o.unitsAhead > 0 ? `${units(o.unitsAhead)}${o.daysAhead !== null ? ` (${o.daysAhead.toFixed(1)}d)` : ""}` : "–",
        sort: o.unitsAhead > 0 ? o.unitsAhead : null,
        copy: o.unitsAhead > 0 ? String(o.unitsAhead) : null,
      },
      suggest: {
        node: o.suggest === null ? "–" : formatIsk(o.suggest),
        sort: o.suggest,
        copy: o.suggest === null ? null : formatPlain(o.suggest),
        title: o.suggest === null ? undefined : formatIskExact(o.suggest),
      },
      value: { node: formatIsk(value(o)), sort: value(o), copy: formatPlain(value(o)), title: formatIskExact(value(o)) },
      expires: { node: relative(o.expires, now), sort: new Date(o.expires).getTime(), copy: expires, title: expires },
    },
  };
}

/**
 * Every open order with its standing, filterable by character, side and status, and searchable,
 * sortable and rearrangeable like every table on the page. Undercut and outbid orders sort first by
 * default, then by what is left on the order.
 */
export function OrdersTable({
  orders,
  characters,
  initialCharacters,
  now,
  showCorp,
}: {
  orders: OrderView[];
  characters: OrderCharacterView[];
  initialCharacters: number[];
  now: number;
  showCorp: boolean;
}) {
  const [picked, setPicked] = useState<number[]>(initialCharacters);
  const [side, setSide] = useState<Side>("all");
  const [show, setShow] = useState<Show>("all");
  const byId = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters]);

  const togglePicked = (id: number) =>
    setPicked((current) => {
      const next = current.includes(id) ? current.filter((c) => c !== id) : [...current, id];
      return next.length === characters.length ? [] : next;
    });

  const rows = orders
    .filter(
      (o) =>
        (picked.length === 0 || picked.includes(o.characterId)) &&
        (side === "all" || o.side === side) &&
        (show === "all" || needsAttention(o.status)),
    )
    // The default order, kept for ties whatever column the table is sorted by.
    .sort((a, b) => statusRank(a) - statusRank(b) || value(b) - value(a))
    .map((o) => orderRow(o, byId.get(o.characterId), now));
  const attention = orders.filter((o) => (picked.length === 0 || picked.includes(o.characterId)) && needsAttention(o.status)).length;

  return (
    <DataTable
      id="orders"
      columns={showCorp ? COLUMNS : COLUMNS.filter((c) => c.key !== "corp")}
      rows={rows}
      defaultSort={{ key: "status", dir: 1 }}
      maxHeight="max-h-[48rem]"
      empty="No open orders match."
      searchPlaceholder="Search orders"
      summary={(shown) => {
        const total = (s: "sell" | "buy") => shown.filter((r) => r.data!.side === s).reduce((sum, r) => sum + value(r.data!), 0);
        return (
          <>
            {shown.length} order{shown.length === 1 ? "" : "s"} shown · sell orders {formatIsk(total("sell"))} · buy orders {formatIsk(total("buy"))} · prices
            copy as plain numbers, ready to paste in game
          </>
        );
      }}
      toolbar={
        <>
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
        </>
      }
    />
  );
}
