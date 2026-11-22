/**
 * Which table columns a viewer shows, and in what order. Pure, so the table and its tests share it;
 * the table keeps it in the viewer's browser only (a per-viewer convenience, never needed to work).
 */

export type ColumnLayout<K extends string> = { order: K[]; hidden: K[] };

/**
 * A saved layout made safe against the columns that exist now: unknown keys are dropped, columns
 * added since are put back where the default has them, and at least one column stays visible.
 */
export function normalizeLayout<K extends string>(saved: unknown, defaults: readonly K[]): ColumnLayout<K> {
  const known = new Set<string>(defaults);
  const pick = (value: unknown): K[] =>
    Array.isArray(value) ? [...new Set(value.filter((k): k is K => typeof k === "string" && known.has(k)))] : [];
  const record = saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {};
  const order = pick(record.order);
  for (const [i, key] of defaults.entries()) {
    if (order.includes(key)) continue;
    // After the default's previous column, so a new column lands near its neighbours.
    const before = defaults.slice(0, i).reverse().find((k) => order.includes(k));
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, key);
  }
  const hidden = pick(record.hidden);
  return { order, hidden: hidden.length >= order.length ? [] : hidden };
}

/** `key` moved to where `target` is now (before it moving left, after it moving right). */
export function moveColumn<K extends string>(order: K[], key: K, target: K): K[] {
  const from = order.indexOf(key);
  const to = order.indexOf(target);
  if (from < 0 || to < 0 || from === to) return order;
  const next = order.filter((k) => k !== key);
  next.splice(to, 0, key);
  return next;
}

/** `key` one place left (-1) or right (+1) among `visible` columns, skipping hidden ones. */
export function stepColumn<K extends string>(order: K[], visible: K[], key: K, step: -1 | 1): K[] {
  const at = visible.indexOf(key);
  const target = visible[at + step];
  return at < 0 || target === undefined ? order : moveColumn(order, key, target);
}

/** Shows or hides a column; the last visible one cannot be hidden. */
export function toggleColumn<K extends string>(layout: ColumnLayout<K>, key: K, available: readonly K[]): ColumnLayout<K> {
  if (layout.hidden.includes(key)) return { ...layout, hidden: layout.hidden.filter((k) => k !== key) };
  const visible = available.filter((k) => !layout.hidden.includes(k));
  if (visible.length <= 1) return layout;
  return { ...layout, hidden: [...layout.hidden, key] };
}
