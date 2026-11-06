import Link from "next/link";
import type { Filters } from "@/lib/income/report";

// Categorical slots, dark steps, in validated order (checked against the site's surface colour).
export const PALETTE = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"];
export const OTHER_COLOR = "#8a94a6";

/** The page's URL with some filters changed; the rest carry over. */
export function hrefWith(filters: Filters, change: Partial<Filters>, hash?: string): string {
  const next = { ...filters, ...change };
  const params = new URLSearchParams();
  if (next.range !== "30d") params.set("range", next.range);
  // A grouping only sticks when the range stays; a new range picks its own default.
  if ("grouping" in change || !("range" in change)) params.set("group", next.grouping);
  for (const source of next.sources) params.append("s", source);
  if (next.stack !== "character") params.set("stack", next.stack);
  if (next.expenses) params.set("exp", "1");
  for (const id of next.characterIds) params.append("c", String(id));
  // A bucket only means something in the range and grouping it was picked in.
  if (next.at && !("range" in change) && !("grouping" in change)) params.set("at", next.at);
  if (next.tradeView !== "category") params.set("tv", next.tradeView);
  if (next.category !== null) params.set("cat", String(next.category));
  const query = params.toString();
  return `${query ? `/income?${query}` : "/income"}${hash ? `#${hash}` : ""}`;
}

/** The filters as hidden form fields, for the character form: everything but the characters carries over. */
export function HiddenFilters({ filters }: { filters: Filters }) {
  const fields: [string, string][] = [];
  if (filters.range !== "30d") fields.push(["range", filters.range]);
  fields.push(["group", filters.grouping]);
  for (const source of filters.sources) fields.push(["s", source]);
  if (filters.stack !== "character") fields.push(["stack", filters.stack]);
  if (filters.expenses) fields.push(["exp", "1"]);
  if (filters.at) fields.push(["at", filters.at]);
  if (filters.tradeView !== "category") fields.push(["tv", filters.tradeView]);
  if (filters.category !== null) fields.push(["cat", String(filters.category)]);
  return fields.map(([name, value], i) => <input key={i} type="hidden" name={name} value={value} />);
}

export function Chip({ href, active, swatch, children }: { href: string; active: boolean; swatch?: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      scroll={false}
      aria-current={active ? "true" : undefined}
      className={`flex items-center gap-1.5 rounded border px-2.5 py-1 text-sm ${active ? "border-accent text-accent" : "border-border hover:border-foreground"}`}
    >
      {swatch && <span className="inline-block size-2.5 rounded-sm" style={{ background: swatch }} />}
      {children}
    </Link>
  );
}


/** "2026-10-18 13:05 EVE", in EVE time like everything else on the page. */
export function eveTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} EVE`;
}

export function Tile({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded border border-border bg-surface p-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-xl font-semibold">{value}</dd>
      <dd className="mt-0.5 text-xs text-muted">{detail}</dd>
    </div>
  );
}

