"use client";

import Image from "next/image";
import Link from "next/link";
import { type ReactNode, useMemo, useState, useSyncExternalStore, useTransition } from "react";
import { syncOpenOrders } from "@/app/income/actions";
import { type ColumnLayout, moveColumn, normalizeLayout, stepColumn, toggleColumn } from "./column-layout";
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

type SortKey =
  | "status"
  | "item"
  | "character"
  | "side"
  | "where"
  | "price"
  | "left"
  | "bestOther"
  | "ahead"
  | "suggest"
  | "corp"
  | "value"
  | "expires";
type Sort = { key: SortKey; dir: 1 | -1 };
// Text sorts A to Z on the first click, numbers largest first; expiry soonest first.
const FIRST_DIR: Record<SortKey, 1 | -1> = {
  status: 1,
  item: 1,
  character: 1,
  side: 1,
  where: 1,
  price: -1,
  left: -1,
  bestOther: -1,
  ahead: -1,
  suggest: -1,
  corp: -1,
  value: -1,
  expires: 1,
};
const DEFAULT_SORT: Sort = { key: "status", dir: 1 };

const statusRank = (o: OrderView) => STATUS[o.status]?.rank ?? 2;
const value = (o: OrderView) => o.price * o.volumeRemain;

/** The sort value of an order in a column; null (no value) always sorts last. */
function sortValue(o: OrderView, key: SortKey, characterName: (id: number) => string): string | number | null {
  switch (key) {
    case "status":
      return statusRank(o);
    case "item":
      return o.typeName;
    case "character":
      return characterName(o.characterId);
    case "side":
      return o.side;
    case "where":
      return o.location;
    case "price":
      return o.price;
    case "left":
      return o.volumeRemain;
    case "bestOther":
      return o.bestOther;
    case "ahead":
      return o.unitsAhead > 0 ? o.unitsAhead : null;
    case "suggest":
      return o.suggest;
    case "corp":
      return o.corp ? o.corp.units + (o.corp.holdsBest ? 1e15 : 0) : null;
    case "value":
      return value(o);
    case "expires":
      return new Date(o.expires).getTime();
  }
}

function compareOrders(a: OrderView, b: OrderView, sort: Sort, characterName: (id: number) => string): number {
  const x = sortValue(a, sort.key, characterName);
  const y = sortValue(b, sort.key, characterName);
  if (x === null || y === null) {
    if (x !== y) return x === null ? 1 : -1;
  } else {
    const order = typeof x === "string" ? x.localeCompare(y as string) : x - (y as number);
    if (order !== 0) return sort.dir * order;
  }
  // Ties: what needs attention first, then what is left on the order.
  return statusRank(a) - statusRank(b) || value(b) - value(a);
}

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
      <p className="text-xs text-muted">
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

type ColumnDef = {
  key: SortKey;
  label: string;
  left?: boolean;
  title?: string;
  className?: string;
  cell: (o: OrderView, ctx: { character: OrderCharacterView | undefined; now: number }) => ReactNode;
  cellTitle?: (o: OrderView) => string | undefined;
  // What a click on the cell copies; null when the cell has nothing to copy.
  copy: (o: OrderView, ctx: { character: OrderCharacterView | undefined }) => string | null;
};

// Plain numbers paste into EVE's price and quantity boxes: no separators, at most two decimals.
const plain = (n: number) => String(Math.round(n * 100) / 100);

const COLUMNS: ColumnDef[] = [
  {
    key: "status",
    label: "Status",
    left: true,
    cell: (o) => {
      const status = STATUS[o.status] ?? STATUS.unknown;
      return (
        <span className={status.tone}>
          {status.icon} {status.label}
        </span>
      );
    },
    cellTitle: (o) => o.note ?? undefined,
    copy: (o) => (STATUS[o.status] ?? STATUS.unknown).label,
  },
  {
    key: "corp",
    label: "Corp",
    left: true,
    title: "A member of this character's corporation, sharing their orders too, is priced ahead of this order",
    cell: (o) =>
      o.corp ? <span className="text-amber-400">⚑ Corp member{o.corp.holdsBest ? " (best)" : ""}</span> : <span className="text-muted">–</span>,
    cellTitle: (o) =>
      o.corp ? `${units(o.corp.units)} units from corp members are priced ahead of this order${o.corp.holdsBest ? ", including the best price" : ""}` : undefined,
    copy: (o) => (o.corp ? "Corp member" : null),
  },
  { key: "item", label: "Item", left: true, className: "max-w-64 truncate", cell: (o) => o.typeName, cellTitle: (o) => o.typeName, copy: (o) => o.typeName },
  {
    key: "character",
    label: "Character",
    left: true,
    cell: (o, { character }) => (
      <span className="flex items-center gap-1.5">
        <span className="inline-block size-2.5 shrink-0 rounded-sm" style={{ background: character?.color }} />
        {character?.name ?? o.characterId}
      </span>
    ),
    copy: (o, { character }) => character?.name ?? String(o.characterId),
  },
  { key: "side", label: "Side", left: true, cell: (o) => (o.side === "sell" ? "Sell" : `Buy${o.range !== "station" ? ` (${o.range})` : ""}`), copy: (o) => (o.side === "sell" ? "Sell" : "Buy") },
  {
    key: "where",
    label: "Where",
    left: true,
    className: "max-w-56 truncate text-muted",
    cell: (o) => o.location,
    cellTitle: (o) => `${o.location}, ${o.region}`,
    copy: (o) => o.location,
  },
  { key: "price", label: "Price", cell: (o) => formatIsk(o.price), cellTitle: (o) => formatIskExact(o.price), copy: (o) => plain(o.price) },
  {
    key: "left",
    label: "Left",
    cell: (o) => {
      const filled = o.volumeTotal > 0 ? (o.volumeTotal - o.volumeRemain) / o.volumeTotal : 0;
      return (
        <div className="flex items-center justify-end gap-2">
          {units(o.volumeRemain)}/{units(o.volumeTotal)}
          <span className="relative inline-block h-1.5 w-12 overflow-hidden rounded bg-border">
            <span className="absolute inset-y-0 left-0 bg-accent" style={{ width: `${(filled * 100).toFixed(1)}%` }} />
          </span>
        </div>
      );
    },
    cellTitle: (o) => `${units(o.volumeTotal - o.volumeRemain)} of ${units(o.volumeTotal)} filled`,
    copy: (o) => String(o.volumeRemain),
  },
  { key: "bestOther", label: "Best other", cell: (o) => (o.bestOther === null ? "–" : formatIsk(o.bestOther)), copy: (o) => (o.bestOther === null ? null : plain(o.bestOther)) },
  {
    key: "ahead",
    label: "Ahead",
    title: "Competing units priced ahead of this order, and how many days of the region's trade they are",
    cell: (o) => (o.unitsAhead > 0 ? `${units(o.unitsAhead)}${o.daysAhead !== null ? ` (${o.daysAhead.toFixed(1)}d)` : ""}` : "–"),
    copy: (o) => (o.unitsAhead > 0 ? String(o.unitsAhead) : null),
  },
  {
    key: "suggest",
    label: "Suggest",
    title: "One tick past the best competitor; a thin, clearly cheaper sliver of sell orders is ignored",
    cell: (o) => (o.suggest === null ? "–" : formatIsk(o.suggest)),
    cellTitle: (o) => (o.suggest === null ? undefined : formatIskExact(o.suggest)),
    copy: (o) => (o.suggest === null ? null : plain(o.suggest)),
  },
  { key: "value", label: "Value left", cell: (o) => formatIsk(value(o)), cellTitle: (o) => formatIskExact(value(o)), copy: (o) => plain(value(o)) },
  { key: "expires", label: "Expires", cell: (o, { now }) => relative(o.expires, now), cellTitle: (o) => o.expires.slice(0, 16).replace("T", " "), copy: (o) => o.expires.slice(0, 16).replace("T", " ") },
];
const COLUMN_KEYS = COLUMNS.map((c) => c.key);
const COLUMN_BY_KEY = new Map(COLUMNS.map((c) => [c.key, c]));

// The viewer's column layout, in this browser only. Storage can be missing or throw (private
// windows, blocked site data): the table then shows the default and changes last until reload.
const LAYOUT_KEY = "drydock.orders.columns.v1";
const layoutListeners = new Set<() => void>();
let layoutFallback: string | null = null;
function readLayout(): string | null {
  try {
    return window.localStorage.getItem(LAYOUT_KEY) ?? layoutFallback;
  } catch {
    return layoutFallback;
  }
}
function writeLayout(layout: ColumnLayout<SortKey> | null) {
  layoutFallback = layout && JSON.stringify(layout);
  try {
    if (layout) window.localStorage.setItem(LAYOUT_KEY, layoutFallback!);
    else window.localStorage.removeItem(LAYOUT_KEY);
  } catch {
    // Kept in memory for this page instead.
  }
  layoutListeners.forEach((listener) => listener());
}
function subscribeLayout(listener: () => void) {
  layoutListeners.add(listener);
  const onStorage = (event: StorageEvent) => event.key === LAYOUT_KEY && listener();
  window.addEventListener("storage", onStorage);
  return () => {
    layoutListeners.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function useColumnLayout(): [ColumnLayout<SortKey>, (layout: ColumnLayout<SortKey> | null) => void] {
  const raw = useSyncExternalStore(subscribeLayout, readLayout, () => null);
  const layout = useMemo(() => {
    let saved: unknown = null;
    try {
      saved = raw ? JSON.parse(raw) : null;
    } catch {
      saved = null;
    }
    return normalizeLayout(saved, COLUMN_KEYS);
  }, [raw]);
  return [layout, writeLayout];
}

function HeaderCell({
  column,
  sort,
  onSort,
  dragging,
  onDragStart,
  onDrop,
  onDragEnd,
}: {
  column: ColumnDef;
  sort: Sort;
  onSort: (key: SortKey) => void;
  dragging: SortKey | null;
  onDragStart: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const active = sort.key === column.key;
  const [over, setOver] = useState(false);
  return (
    <th
      draggable
      onDragStart={(event) => {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", column.key);
        onDragStart();
      }}
      onDragOver={(event) => {
        if (dragging === null || dragging === column.key) return;
        event.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault();
        setOver(false);
        onDrop();
      }}
      onDragEnd={onDragEnd}
      className={`cursor-grab p-0 font-normal ${column.left ? "text-left" : ""} ${over ? "bg-accent/15" : ""} ${dragging === column.key ? "opacity-50" : ""}`}
      aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
      title={column.title ? `${column.title}. Drag to move the column.` : "Drag to move the column."}
    >
      <button
        type="button"
        onClick={() => onSort(column.key)}
        className={`flex w-full items-center gap-1 p-2 hover:text-foreground ${column.left ? "" : "justify-end"} ${active ? "text-foreground" : ""}`}
      >
        {column.label}
        <span aria-hidden className={active ? "" : "invisible"}>
          {sort.dir === 1 ? "▲" : "▼"}
        </span>
      </button>
    </th>
  );
}

/** Show, hide and reorder the columns; the table's headers can also be dragged. */
function ColumnMenu({
  layout,
  available,
  onChange,
}: {
  layout: ColumnLayout<SortKey>;
  available: SortKey[];
  onChange: (layout: ColumnLayout<SortKey> | null) => void;
}) {
  const listed = layout.order.filter((k) => available.includes(k));
  const visible = listed.filter((k) => !layout.hidden.includes(k));
  const customised = JSON.stringify(layout) !== JSON.stringify(normalizeLayout(null, COLUMN_KEYS));
  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded border border-border px-2.5 py-1 text-sm hover:border-foreground">
        Columns {visible.length < listed.length && <span className="text-muted">({visible.length}/{listed.length})</span>}
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-64 space-y-1 rounded border border-border bg-surface p-2 text-sm shadow-lg">
        <ul className="space-y-0.5">
          {listed.map((key) => {
            const column = COLUMN_BY_KEY.get(key)!;
            const shown = !layout.hidden.includes(key);
            const at = visible.indexOf(key);
            return (
              <li key={key} className="flex items-center gap-1 rounded px-1 hover:bg-background">
                <label className="flex flex-1 cursor-pointer items-center gap-2 py-1">
                  <input
                    type="checkbox"
                    checked={shown}
                    disabled={shown && visible.length <= 1}
                    onChange={() => onChange(toggleColumn(layout, key, available))}
                  />
                  {column.label}
                </label>
                <button
                  type="button"
                  aria-label={`Move ${column.label} left`}
                  disabled={!shown || at <= 0}
                  onClick={() => onChange({ ...layout, order: stepColumn(layout.order, visible, key, -1) })}
                  className="rounded px-1.5 text-muted hover:text-foreground disabled:invisible"
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${column.label} right`}
                  disabled={!shown || at < 0 || at >= visible.length - 1}
                  onClick={() => onChange({ ...layout, order: stepColumn(layout.order, visible, key, 1) })}
                  className="rounded px-1.5 text-muted hover:text-foreground disabled:invisible"
                >
                  ↓
                </button>
              </li>
            );
          })}
        </ul>
        <div className="flex items-center justify-between border-t border-border pt-2 text-xs text-muted">
          <span>Or drag the headers.</span>
          <button type="button" disabled={!customised} onClick={() => onChange(null)} className="text-accent hover:underline disabled:text-muted disabled:no-underline">
            Reset
          </button>
        </div>
      </div>
    </details>
  );
}

/**
 * Every open order with its standing, filterable by character, side and status without a round trip,
 * and sortable by any column. Undercut and outbid orders sort first by default, then by what is left.
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
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const [layout, setLayout] = useColumnLayout();
  const [dragging, setDragging] = useState<SortKey | null>(null);
  const [copied, setCopied] = useState<{ cell: string; ok: boolean } | null>(null);
  const copyCell = async (cell: string, text: string) => {
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      ok = false; // No clipboard access (an insecure page, or the browser refused).
    }
    setCopied({ cell, ok });
    setTimeout(() => setCopied((current) => (current?.cell === cell ? null : current)), 1200);
  };
  // Corp only exists while one of the viewer's characters shares its orders.
  const available = COLUMN_KEYS.filter((k) => k !== "corp" || showCorp);
  const columns = layout.order.filter((k) => available.includes(k) && !layout.hidden.includes(k)).map((k) => COLUMN_BY_KEY.get(k)!);
  const byId = useMemo(() => new Map(characters.map((c) => [c.id, c])), [characters]);
  const characterName = (id: number) => byId.get(id)?.name ?? String(id);
  const onSort = (key: SortKey) =>
    setSort((current) => (current.key === key ? { key, dir: current.dir === 1 ? -1 : 1 } : { key, dir: FIRST_DIR[key] }));

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
    .sort((a, b) => compareOrders(a, b, sort, characterName));
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
        <div className="ml-auto">
          <ColumnMenu layout={layout} available={available} onChange={setLayout} />
        </div>
      </div>
      <p className="text-xs text-muted">
        {shown.length} order{shown.length === 1 ? "" : "s"} shown · sell orders {formatIsk(sellValue)} · buy orders {formatIsk(buyValue)} · click a cell to copy it (prices as plain numbers, ready to paste in game)
      </p>
      <div className="max-h-[48rem] overflow-auto rounded border border-border bg-surface">
        <table className="w-full text-right text-sm whitespace-nowrap tabular-nums">
          <thead className="sticky top-0 bg-surface text-xs text-muted">
            <tr className="border-b border-border">
              {columns.map((column) => (
                <HeaderCell
                  key={column.key}
                  column={column}
                  sort={sort}
                  onSort={onSort}
                  dragging={dragging}
                  onDragStart={() => setDragging(column.key)}
                  onDrop={() => {
                    if (dragging) setLayout({ ...layout, order: moveColumn(layout.order, dragging, column.key) });
                    setDragging(null);
                  }}
                  onDragEnd={() => setDragging(null)}
                />
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {shown.map((o) => {
              const ctx = { character: byId.get(o.characterId), now };
              return (
                <tr key={o.orderId}>
                  {columns.map((column) => {
                    const text = column.copy(o, ctx);
                    const cell = `${o.orderId}:${column.key}`;
                    const flash = copied?.cell === cell ? copied : null;
                    const title = column.cellTitle?.(o);
                    return (
                      <td
                        key={column.key}
                        className={`relative p-2 ${column.left ? "text-left" : ""} ${column.className ?? ""} ${text === null ? "" : "cursor-copy hover:bg-background/60"}`}
                        title={text === null ? title : `${title ? `${title}. ` : ""}Click to copy ${text}`}
                        tabIndex={text === null ? undefined : 0}
                        onClick={text === null ? undefined : () => copyCell(cell, text)}
                        onKeyDown={
                          text === null
                            ? undefined
                            : (event) => {
                                if (event.key !== "Enter" && event.key !== " ") return;
                                event.preventDefault();
                                copyCell(cell, text);
                              }
                        }
                      >
                        {column.cell(o, ctx)}
                        {flash && (
                          <span
                            role="status"
                            className={`pointer-events-none absolute inset-y-1 right-1 flex items-center rounded px-1.5 text-xs font-medium ${flash.ok ? "bg-accent text-black" : "bg-red-400 text-black"}`}
                          >
                            {flash.ok ? "Copied" : "Copy failed"}
                          </span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {shown.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="p-4 text-center text-muted">
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
