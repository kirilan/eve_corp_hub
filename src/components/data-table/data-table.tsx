"use client";

import { type ReactNode, useMemo, useState, useSyncExternalStore } from "react";
import { type ColumnLayout, moveColumn, normalizeLayout, stepColumn, toggleColumn } from "./column-layout";

/**
 * A table the viewer can sort by any column, search, rearrange (show, hide and move columns, by menu
 * or by dragging headers) and copy from (a click on a cell copies its value). Each table's layout is
 * kept in the viewer's browser under its `id`.
 *
 * Cells arrive already rendered (`node`), so a Server Component can build the rows with its own
 * links, forms and formatting; `sort` and `copy` are the plain values behind them.
 */

export type DataColumn = {
  key: string;
  label: string;
  // Name in the Columns menu, when the header itself is blank or terse.
  menuLabel?: string;
  left?: boolean;
  title?: string;
  // Direction of the first click: text A to Z, numbers largest first, unless said otherwise.
  firstDir?: 1 | -1;
  sortable?: boolean;
};

export type DataCell = {
  node: ReactNode;
  // Null (no value) always sorts last.
  sort?: string | number | null;
  // What a click copies; nothing to copy when null or missing.
  copy?: string | null;
  // Extra text the search matches, besides `copy`.
  search?: string;
  title?: string;
  className?: string;
};

export type DataRow<T = undefined> = {
  key: string | number;
  cells: Record<string, DataCell | undefined>;
  data?: T;
  // Classes for the whole row (e.g. bold for unread).
  className?: string;
};

export type Sort = { key: string; dir: 1 | -1 };

// ---- Layout, per table, in this browser only. Storage can be missing or throw (private windows,
// blocked site data): the table then shows its default and changes last until the page reloads.

const listeners = new Map<string, Set<() => void>>();
const fallback = new Map<string, string | null>();
const storageKey = (id: string) => `drydock.${id}.columns.v1`;

function readLayout(id: string): string | null {
  try {
    return window.localStorage.getItem(storageKey(id)) ?? fallback.get(id) ?? null;
  } catch {
    return fallback.get(id) ?? null;
  }
}

function writeLayout(id: string, layout: ColumnLayout<string> | null) {
  const raw = layout && JSON.stringify(layout);
  fallback.set(id, raw);
  try {
    if (raw) window.localStorage.setItem(storageKey(id), raw);
    else window.localStorage.removeItem(storageKey(id));
  } catch {
    // Kept in memory for this page instead.
  }
  listeners.get(id)?.forEach((listener) => listener());
}

function subscribe(id: string, listener: () => void) {
  if (!listeners.has(id)) listeners.set(id, new Set());
  listeners.get(id)!.add(listener);
  const onStorage = (event: StorageEvent) => event.key === storageKey(id) && listener();
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.get(id)?.delete(listener);
    window.removeEventListener("storage", onStorage);
  };
}

function useLayout(id: string, keys: string[]): [ColumnLayout<string>, (layout: ColumnLayout<string> | null) => void, boolean] {
  const raw = useSyncExternalStore(
    (listener) => subscribe(id, listener),
    () => readLayout(id),
    () => null,
  );
  const signature = keys.join("|");
  const layout = useMemo(() => {
    let saved: unknown = null;
    try {
      saved = raw ? JSON.parse(raw) : null;
    } catch {
      saved = null;
    }
    return normalizeLayout(saved, signature.split("|"), { keepUnknown: true });
  }, [raw, signature]);
  return [layout, (next) => writeLayout(id, next), raw !== null];
}

// ---- Sorting and searching

function compare(a: DataRow<unknown>, b: DataRow<unknown>, sort: Sort): number {
  const x = a.cells[sort.key]?.sort ?? null;
  const y = b.cells[sort.key]?.sort ?? null;
  if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
  const order = typeof x === "string" || typeof y === "string" ? String(x).localeCompare(String(y)) : x - y;
  return sort.dir * order;
}

const searchText = (row: DataRow<unknown>) =>
  Object.values(row.cells)
    .map((cell) => `${cell?.copy ?? ""} ${cell?.search ?? ""} ${typeof cell?.node === "string" || typeof cell?.node === "number" ? cell.node : ""}`)
    .join(" ")
    .toLowerCase();

// Clicks on these inside a cell do their own thing (follow a link, press a button) instead of copying.
const INTERACTIVE = "a, button, input, select, textarea, summary, label";

// ---- Pieces

function HeaderCell({
  column,
  sort,
  onSort,
  dragging,
  onDragStart,
  onDrop,
  onDragEnd,
}: {
  column: DataColumn;
  sort: Sort | null;
  onSort: () => void;
  dragging: string | null;
  onDragStart: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
}) {
  const active = sort?.key === column.key;
  const sortable = column.sortable !== false;
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
      aria-sort={active ? (sort!.dir === 1 ? "ascending" : "descending") : undefined}
      title={column.title ? `${column.title}. Drag to move the column.` : "Drag to move the column."}
    >
      {sortable ? (
        <button
          type="button"
          onClick={onSort}
          className={`flex w-full items-center gap-1 p-2 hover:text-foreground ${column.left ? "" : "justify-end"} ${active ? "text-foreground" : ""}`}
        >
          {column.label}
          <span aria-hidden className={active ? "" : "invisible"}>
            {sort?.dir === 1 ? "▲" : "▼"}
          </span>
        </button>
      ) : (
        <span className={`flex p-2 ${column.left ? "" : "justify-end"}`}>{column.label}</span>
      )}
    </th>
  );
}

function ColumnMenu({
  columns,
  layout,
  customised,
  onChange,
}: {
  columns: DataColumn[];
  layout: ColumnLayout<string>;
  customised: boolean;
  onChange: (layout: ColumnLayout<string> | null) => void;
}) {
  const present = columns.map((c) => c.key);
  const byKey = new Map(columns.map((c) => [c.key, c]));
  const listed = layout.order.filter((k) => byKey.has(k));
  const visible = listed.filter((k) => !layout.hidden.includes(k));
  return (
    <details className="relative">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded border border-border px-2.5 py-1 text-sm hover:border-foreground">
        Columns {visible.length < listed.length && <span className="text-muted">({visible.length}/{listed.length})</span>}
      </summary>
      <div className="absolute right-0 z-20 mt-1 w-64 space-y-1 rounded border border-border bg-surface p-2 text-sm shadow-lg">
        <ul className="max-h-80 space-y-0.5 overflow-auto">
          {listed.map((key) => {
            const column = byKey.get(key)!;
            const label = column.menuLabel ?? column.label;
            const shown = !layout.hidden.includes(key);
            const at = visible.indexOf(key);
            return (
              <li key={key} className="flex items-center gap-1 rounded px-1 hover:bg-background">
                <label className="flex flex-1 cursor-pointer items-center gap-2 py-1">
                  <input
                    type="checkbox"
                    checked={shown}
                    disabled={shown && visible.length <= 1}
                    onChange={() => onChange(toggleColumn(layout, key, present))}
                  />
                  {label}
                </label>
                <button
                  type="button"
                  aria-label={`Move ${label} left`}
                  disabled={!shown || at <= 0}
                  onClick={() => onChange({ ...layout, order: stepColumn(layout.order, visible, key, -1) })}
                  className="rounded px-1.5 text-muted hover:text-foreground disabled:invisible"
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${label} right`}
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
          <button
            type="button"
            disabled={!customised}
            onClick={() => onChange(null)}
            className="text-accent hover:underline disabled:text-muted disabled:no-underline"
          >
            Reset
          </button>
        </div>
      </div>
    </details>
  );
}

// ---- The table

export function DataTable<T = undefined>({
  id,
  columns,
  rows,
  defaultSort = null,
  empty = "Nothing to show.",
  maxHeight = "max-h-[32rem]",
  toolbar,
  summary,
  searchPlaceholder = "Search",
  onCopy,
}: {
  id: string;
  columns: DataColumn[];
  rows: DataRow<T>[];
  // Null keeps the rows in the order given until a header is clicked.
  defaultSort?: Sort | null;
  empty?: ReactNode;
  maxHeight?: string;
  // Filters of the table's own, shown before the search box.
  toolbar?: ReactNode;
  // A line about the rows shown (after filtering), above the table; client callers only.
  summary?: (shown: DataRow<T>[]) => ReactNode;
  searchPlaceholder?: string;
  // Told after a cell is copied, with its row and column; client callers only.
  onCopy?: (row: DataRow<T>, columnKey: string) => void;
}) {
  const keys = columns.map((c) => c.key);
  const [layout, setLayout, customised] = useLayout(id, keys);
  const [sort, setSort] = useState<Sort | null>(defaultSort);
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState<string | null>(null);
  const [copied, setCopied] = useState<{ cell: string; ok: boolean } | null>(null);

  const byKey = new Map(columns.map((c) => [c.key, c]));
  const shownColumns = layout.order.filter((k) => byKey.has(k) && !layout.hidden.includes(k)).map((k) => byKey.get(k)!);

  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matched = words.length === 0 ? rows : rows.filter((row) => {
    const text = searchText(row as DataRow<unknown>);
    return words.every((word) => text.includes(word));
  });
  // Array sort is stable: ties keep the order the rows came in.
  const shown = sort && byKey.has(sort.key) ? [...matched].sort((a, b) => compare(a as DataRow<unknown>, b as DataRow<unknown>, sort)) : matched;

  const onSort = (column: DataColumn) =>
    setSort((current) =>
      current?.key === column.key
        ? { key: column.key, dir: current.dir === 1 ? -1 : 1 }
        : { key: column.key, dir: column.firstDir ?? (column.left ? 1 : -1) },
    );

  const copy = async (cell: string, text: string, row: DataRow<T>, columnKey: string) => {
    onCopy?.(row, columnKey);
    let ok = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      ok = false; // No clipboard access (an insecure page, or the browser refused).
    }
    setCopied({ cell, ok });
    setTimeout(() => setCopied((current) => (current?.cell === cell ? null : current)), 1200);
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {toolbar}
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={searchPlaceholder}
          aria-label={searchPlaceholder}
          className="w-48 rounded border border-border bg-background px-2 py-1 text-sm"
        />
        <div className="ml-auto">
          <ColumnMenu columns={columns} layout={layout} customised={customised} onChange={setLayout} />
        </div>
      </div>
      <p className="text-xs text-muted">
        {summary ? summary(shown) : `${shown.length} of ${rows.length} shown`} · click a cell to copy it
      </p>
      <div className={`${maxHeight} overflow-auto rounded border border-border bg-surface`}>
        <table className="w-full text-right text-sm whitespace-nowrap tabular-nums">
          <thead className="sticky top-0 z-10 bg-surface text-xs text-muted">
            <tr className="border-b border-border">
              {shownColumns.map((column) => (
                <HeaderCell
                  key={column.key}
                  column={column}
                  sort={sort}
                  onSort={() => onSort(column)}
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
            {shown.map((row) => (
              <tr key={row.key} className={row.className}>
                {shownColumns.map((column) => {
                  const cell = row.cells[column.key];
                  const text = cell?.copy ?? null;
                  const id = `${row.key}:${column.key}`;
                  const flash = copied?.cell === id ? copied : null;
                  return (
                    <td
                      key={column.key}
                      className={`relative p-2 ${column.left ? "text-left" : ""} ${cell?.className ?? ""} ${text === null ? "" : "cursor-copy hover:bg-background/60"}`}
                      title={text === null ? cell?.title : `${cell?.title ? `${cell.title}. ` : ""}Click to copy ${text}`}
                      tabIndex={text === null ? undefined : 0}
                      onClick={
                        text === null
                          ? undefined
                          : (event) => {
                              if ((event.target as Element).closest(INTERACTIVE)) return;
                              copy(id, text, row, column.key);
                            }
                      }
                      onKeyDown={
                        text === null
                          ? undefined
                          : (event) => {
                              if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return;
                              event.preventDefault();
                              copy(id, text, row, column.key);
                            }
                      }
                    >
                      {cell?.node ?? ""}
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
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={Math.max(1, shownColumns.length)} className="p-4 text-center text-muted">
                  {rows.length === 0 ? empty : "Nothing matches the search."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
