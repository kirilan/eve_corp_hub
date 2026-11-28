"use client";

import Image from "next/image";
import Link from "next/link";
import { useCallback, useMemo, useState, useSyncExternalStore, useTransition } from "react";
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
  own: { units: number; characterIds: number[]; holdsBest: boolean } | null;
  reprocess: {
    kind: "floor" | "ceiling";
    price: number;
    ratio: number;
    rate: number;
    partial: boolean;
    reprocessingTax: number;
    salesTax: number;
    assumed: string[];
  } | null;
};

export type OrderCharacterView = { id: number; name: string; portrait: string; color: string };

// Mirrors `OrdersReport` from src/lib/orders/check.ts.
export type OrdersReportView = {
  characters: {
    id: number;
    name: string;
    allowed: boolean;
    sharing: boolean;
    error: string | null;
    orders: number;
    ordersAsOf: string | null;
    ordersNextRefresh: string | null;
  }[];
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

// ---- Unread: an undercut or outbid order shows bold until its item name is copied (to re-price it in
// game). Kept in this browser only. The key holds the order's price and the best competing price, so a
// re-priced order, or a new undercut, is unread again.

const READ_KEY = "orders:read";
const readKey = (o: OrderView) => `${o.orderId}:${o.price}:${o.bestOther ?? ""}`;
const readListeners = new Set<() => void>();

function subscribeRead(listener: () => void) {
  readListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    readListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readSnapshot(): string {
  try {
    return window.localStorage.getItem(READ_KEY) ?? "[]";
  } catch {
    return "[]"; // Storage blocked: everything stays unread for this visit.
  }
}

/** The read keys, null until the browser's copy is known (nothing shows bold before then). */
function useReadOrders(current: OrderView[]) {
  const raw = useSyncExternalStore(subscribeRead, readSnapshot, () => null);
  const read = useMemo(() => {
    if (raw === null) return null;
    try {
      const keys: unknown = JSON.parse(raw);
      return new Set(Array.isArray(keys) ? keys.filter((k): k is string => typeof k === "string") : []);
    } catch {
      return new Set<string>();
    }
  }, [raw]);
  const markRead = useCallback(
    (order: OrderView) => {
      // Only keys of orders still flagged are kept, so the list never outgrows the open orders.
      const live = new Set(current.filter((o) => needsAttention(o.status)).map(readKey));
      const next = [...(read ?? [])].filter((k) => live.has(k));
      next.push(readKey(order));
      try {
        window.localStorage.setItem(READ_KEY, JSON.stringify([...new Set(next)]));
      } catch {
        return;
      }
      for (const listener of readListeners) listener();
    },
    [current, read],
  );
  return { read, markRead };
}

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
  // The oldest order list read sets how stale the page can be; the soonest refresh is when syncing helps again.
  const ordersAsOf = allowed
    .map((c) => c.ordersAsOf)
    .filter((d): d is string => d !== null)
    .sort()[0];
  const nextRefresh = allowed
    .map((c) => c.ordersNextRefresh)
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
        {ordersAsOf && (
          <span
            className="text-xs text-muted"
            title="When EVE last rebuilt the order list it serves (oldest across your characters). EVE caches it for up to 20 minutes."
          >
            · EVE data from {eveTime(new Date(ordersAsOf))}
            {nextRefresh && new Date(nextRefresh).getTime() > report.checkedAt ? ` · next update ${eveTime(new Date(nextRefresh)).replace(/^\S+ /, "")}` : ""}
          </span>
        )}
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
        so a new or changed order can take that long to show, however often you sync. For items that reprocess,{" "}
        <em>Floor / ceiling</em> is what one unit&apos;s materials fetch in the station&apos;s own buy orders, after the
        character&apos;s reprocessing yield and tax (read from its skills and standings when it allows that, as on{" "}
        <Link href="/industry" className="text-accent hover:underline">
          Industry
        </Link>
        ): a sell order listed below its floor would bring more reprocessed, and a buy order above its ceiling (the same,
        after sales tax) loses ISK if reprocessed. <em>vs floor</em> is the order&apos;s price as a percentage of it;{" "}
        <span className="text-amber-400">⚠</span> marks an order whose suggested price would cross it. <em>Rival</em> shows{" "}
        <span className="text-sky-300">⇄</span> when another order of yours, from any of your characters, is priced ahead
        of one: you are competing with yourself. Undercut and outbid orders show <strong>bold</strong> until you copy their
        item name (to re-price it in game); a re-priced order, or a new undercut, is bold again. That is remembered in this
        browser only.{" "}
        {sharing ? (
          <>
            <span className="text-amber-400">⚑</span> <em>Corp member</em> marks orders where a member of the character&apos;s corporation who also shares their orders is
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
  {
    key: "corp",
    label: "Rival",
    left: true,
    title: "Who else is priced ahead of this order: another order of yours (any of your characters), or a member of this character's corporation sharing their orders too",
  },
  { key: "item", label: "Item", left: true },
  { key: "character", label: "Character", left: true },
  { key: "side", label: "Side", left: true },
  { key: "where", label: "Where", left: true },
  { key: "price", label: "Price" },
  { key: "left", label: "Left" },
  { key: "bestOther", label: "Best other" },
  { key: "ahead", label: "Ahead", title: "Competing units priced ahead of this order, and how many days of the region's trade they are" },
  { key: "suggest", label: "Suggest", title: "One tick past the best competitor; a thin, clearly cheaper sliver of sell orders is ignored" },
  {
    key: "floor",
    label: "Floor / ceiling",
    title:
      "Items that reprocess: what one unit's materials fetch in this station's buy orders, after your reprocessing yield and tax. A sell order's floor (listed below it, reprocessing pays more); a buy order's ceiling, after sales tax too (bought above it, reprocessing loses)",
  },
  {
    key: "vsFloor",
    label: "vs floor",
    title: "The order's price as a percentage of its reprocess floor (sell) or ceiling (buy): a sell order under 100% or a buy order over 100% is past it",
  },
  { key: "value", label: "Value left" },
  { key: "expires", label: "Expires", firstDir: 1 },
];

const statusRank = (o: OrderView) => STATUS[o.status]?.rank ?? 2;
const value = (o: OrderView) => o.price * o.volumeRemain;

function rivalCell(o: OrderView, nameOf: (id: number) => string) {
  if (!o.own && !o.corp) return { node: <span className="text-muted">–</span>, sort: null, copy: null };
  const own = o.own;
  const ownLabel = own
    ? own.characterIds.length === 1 && own.characterIds[0] === o.characterId
      ? "Your other order"
      : `Your ${own.characterIds.filter((id) => id !== o.characterId).map(nameOf).join(", ")}`
    : null;
  const titles = [
    own &&
      `${units(own.units)} units of your own orders (${own.characterIds.map(nameOf).join(", ")}) are priced ahead of this one${own.holdsBest ? ", at the best price" : ""}`,
    o.corp && `${units(o.corp.units)} units from corp members are priced ahead of this order${o.corp.holdsBest ? ", including the best price" : ""}`,
  ].filter(Boolean);
  return {
    node: (
      <span className="flex flex-col gap-0.5">
        {own && (
          <span className="text-sky-300">
            ⇄ {ownLabel}
            {own.holdsBest ? " (best)" : ""}
          </span>
        )}
        {o.corp && <span className="text-amber-400">⚑ Corp member{o.corp.holdsBest ? " (best)" : ""}</span>}
      </span>
    ),
    // Whoever holds the best price first, then by units ahead.
    sort: (own?.units ?? 0) + (o.corp?.units ?? 0) + (own?.holdsBest || o.corp?.holdsBest ? 1e15 : 0),
    copy: [own && ownLabel, o.corp && "Corp member"].filter(Boolean).join(", "),
    title: titles.join("; "),
  };
}

const pct = (fraction: number) => `${(fraction * 100).toFixed(fraction < 0.1 ? 1 : 0)}%`;

/** A sell order under its floor, or a buy order over its ceiling. */
const pastFloor = (o: OrderView) => o.reprocess !== null && (o.side === "sell" ? o.reprocess.ratio < 1 : o.reprocess.ratio > 1);
/** The suggested price would take the order past its floor or ceiling. */
const suggestPast = (o: OrderView) =>
  o.reprocess !== null && o.suggest !== null && (o.side === "sell" ? o.suggest < o.reprocess.price : o.suggest > o.reprocess.price);

function floorCells(o: OrderView) {
  const r = o.reprocess;
  if (!r) {
    const none = { node: <span className="text-muted">–</span>, sort: null, copy: null };
    return { floor: none, vsFloor: none };
  }
  const name = r.kind === "floor" ? "floor" : "ceiling";
  const how = [
    `Reprocess ${name}: ${formatIskExact(r.price)} a unit`,
    `${pct(r.rate)} of the recipe after ${pct(r.reprocessingTax)} reprocessing tax`,
    r.kind === "ceiling" ? `less ${pct(r.salesTax)} sales tax on the materials` : "the item and its materials pay the same sales tax",
    "materials sold into this station's buy orders, for the units left",
    r.partial ? "some materials have too few buyers here, so it counts only what sells" : null,
    ...r.assumed,
  ].filter(Boolean);
  const past = pastFloor(o);
  const crossing = suggestPast(o);
  const suggestNote = crossing
    ? `The suggested ${formatIsk(o.suggest!)} is ${o.side === "sell" ? "below the floor" : "above the ceiling"}: reprocessing would pay more than matching it.`
    : null;
  return {
    floor: {
      node: (
        <span className={r.partial ? "text-muted" : undefined}>
          {formatIsk(r.price)}
          {r.partial ? "*" : ""}
        </span>
      ),
      sort: r.price,
      copy: formatPlain(r.price),
      title: how.join("; "),
    },
    vsFloor: {
      node: (
        <span className={past ? "text-red-300" : crossing ? "text-amber-400" : undefined}>
          {past ? "▼ " : crossing ? "⚠ " : ""}
          {pct(r.ratio)}
        </span>
      ),
      sort: r.ratio,
      copy: pct(r.ratio),
      title: [
        `Price is ${pct(r.ratio)} of the reprocess ${name}`,
        past
          ? o.side === "sell"
            ? "below it: the item brings less sold than reprocessed"
            : "above it: the item is worth less reprocessed than it costs"
          : null,
        suggestNote,
      ]
        .filter(Boolean)
        .join(". "),
    },
  };
}

function orderRow(
  o: OrderView,
  character: OrderCharacterView | undefined,
  now: number,
  nameOf: (id: number) => string,
  unread: boolean,
): DataRow<OrderView> {
  const status = STATUS[o.status] ?? STATUS.unknown;
  const filled = o.volumeTotal > 0 ? (o.volumeTotal - o.volumeRemain) / o.volumeTotal : 0;
  const expires = o.expires.slice(0, 16).replace("T", " ");
  return {
    key: o.orderId,
    data: o,
    className: unread ? "font-bold text-foreground" : undefined,
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
      corp: rivalCell(o, nameOf),
      item: {
        node: (
          <span className="flex items-center gap-1.5">
            {unread && <span aria-label="Unread" className="inline-block size-1.5 shrink-0 rounded-full bg-red-300" />}
            <span className="truncate">{o.typeName}</span>
          </span>
        ),
        sort: o.typeName,
        copy: o.typeName,
        title: unread ? `${o.typeName} (not handled yet: copy the name to mark it read)` : o.typeName,
        className: "max-w-64",
      },
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
      ...floorCells(o),
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
  const nameOf = (id: number) => byId.get(id)?.name ?? `Character ${id}`;
  const { read, markRead } = useReadOrders(orders);
  const isUnread = (o: OrderView) => read !== null && needsAttention(o.status) && !read.has(readKey(o));

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
    .map((o) => orderRow(o, byId.get(o.characterId), now, nameOf, isUnread(o)));
  const flagged = orders.filter((o) => (picked.length === 0 || picked.includes(o.characterId)) && needsAttention(o.status));
  const attention = flagged.length;
  const unread = flagged.filter(isUnread).length;

  return (
    <DataTable
      id="orders"
      columns={COLUMNS.filter(
        (c) =>
          (c.key !== "corp" || showCorp || orders.some((o) => o.own)) &&
          ((c.key !== "floor" && c.key !== "vsFloor") || orders.some((o) => o.reprocess)),
      )}
      onCopy={(row, column) => {
        if (column === "item" && row.data && isUnread(row.data)) markRead(row.data);
      }}
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
            <span className="text-red-300">▼</span> Undercut or outbid ({attention}
            {unread > 0 ? `, ${unread} unread` : ""})
          </Toggle>
        </>
      }
    />
  );
}
