/** ISK in EVE's own shorthand: 950, 12.5K, 340M, 1.24B. */
export function formatIsk(value: number): string {
  const abs = Math.abs(value);
  const [divisor, suffix] = abs >= 1e12 ? [1e12, "T"] : abs >= 1e9 ? [1e9, "B"] : abs >= 1e6 ? [1e6, "M"] : abs >= 1e3 ? [1e3, "K"] : [1, ""];
  const scaled = value / divisor;
  const digits = suffix === "" || Math.abs(scaled) >= 100 ? 0 : Math.abs(scaled) >= 10 ? 1 : 2;
  return `${scaled.toFixed(digits)}${suffix}`;
}

/** Full ISK with thousands separators, for tooltips and tables. */
export function formatIskExact(value: number): string {
  return `${Math.round(value).toLocaleString("en-US")} ISK`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A bucket's first day as a short label: "Oct 18" for days and weeks, "Oct 2026" for months. */
export function formatBucket(day: string, grouping: "day" | "week" | "month"): string {
  const month = MONTHS[Number(day.slice(5, 7)) - 1];
  return grouping === "month" ? `${month} ${day.slice(0, 4)}` : `${month} ${Number(day.slice(8, 10))}`;
}
