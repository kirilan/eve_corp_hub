"use client";

import Image from "next/image";
import Link from "next/link";
import { useMemo, useState, useTransition } from "react";
import { syncOpenOrders } from "@/app/income/actions";
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

function SortHeader({
  label,
  column,
  sort,
  onSort,
  left,
  title,
}: {
  label: string;
  column: SortKey;
  sort: Sort;
  onSort: (key: SortKey) => void;
  left?: boolean;
  title?: string;
}) {
  const active = sort.key === column;
  return (
    <th
      className={`p-0 font-normal ${left ? "text-left" : ""}`}
      aria-sort={active ? (sort.dir === 1 ? "ascending" : "descending") : "none"}
      title={title}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`flex w-full items-center gap-1 p-2 hover:text-foreground ${left ? "" : "justify-end"} ${active ? "text-foreground" : ""}`}
      >
        {label}
        <span aria-hidden className={active ? "" : "invisible"}>
          {sort.dir === 1 ? "▲" : "▼"}
        </span>
      </button>
    </th>
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
      </div>
      <p className="text-xs text-muted">
        {shown.length} order{shown.length === 1 ? "" : "s"} shown · sell orders {formatIsk(sellValue)} · buy orders {formatIsk(buyValue)}
      </p>
      <div className="max-h-[36rem] overflow-auto rounded border border-border bg-surface">
        <table className="w-full text-right text-sm whitespace-nowrap tabular-nums">
          <thead className="sticky top-0 bg-surface text-xs text-muted">
            <tr className="border-b border-border">
              <SortHeader label="Status" column="status" sort={sort} onSort={onSort} left />
              <SortHeader label="Item" column="item" sort={sort} onSort={onSort} left />
              <SortHeader label="Character" column="character" sort={sort} onSort={onSort} left />
              <SortHeader label="Side" column="side" sort={sort} onSort={onSort} left />
              <SortHeader label="Where" column="where" sort={sort} onSort={onSort} left />
              <SortHeader label="Price" column="price" sort={sort} onSort={onSort} />
              <SortHeader label="Left" column="left" sort={sort} onSort={onSort} />
              <SortHeader label="Best other" column="bestOther" sort={sort} onSort={onSort} />
              <SortHeader
                label="Ahead"
                column="ahead"
                sort={sort}
                onSort={onSort}
                title="Competing units priced ahead of this order, and how many days of the region's trade they are"
              />
              {showCorp && (
                <SortHeader
                  label="Corp"
                  column="corp"
                  sort={sort}
                  onSort={onSort}
                  left
                  title="A member of this character's corporation, sharing their orders too, is priced ahead of this order"
                />
              )}
              <SortHeader
                label="Suggest"
                column="suggest"
                sort={sort}
                onSort={onSort}
                title="One tick past the best competitor; a thin, clearly cheaper sliver of sell orders is ignored"
              />
              <SortHeader label="Value left" column="value" sort={sort} onSort={onSort} />
              <SortHeader label="Expires" column="expires" sort={sort} onSort={onSort} />
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
                  {showCorp && (
                    <td
                      className="p-2 text-left text-amber-400"
                      title={
                        o.corp
                          ? `${units(o.corp.units)} units from corp members are priced ahead of this order${o.corp.holdsBest ? ", including the best price" : ""}`
                          : undefined
                      }
                    >
                      {o.corp ? `⚑ Corp member${o.corp.holdsBest ? " (best)" : ""}` : <span className="text-muted">–</span>}
                    </td>
                  )}
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
                <td colSpan={showCorp ? 13 : 12} className="p-4 text-center text-muted">
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
