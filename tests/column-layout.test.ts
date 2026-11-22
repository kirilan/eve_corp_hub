import { describe, expect, it } from "vitest";
import { moveColumn, normalizeLayout, stepColumn, toggleColumn } from "@/components/data-table/column-layout";

const DEFAULTS = ["status", "corp", "item", "price", "expires"] as const;
type Key = (typeof DEFAULTS)[number];

describe("column layout", () => {
  it("falls back to the default for nothing or garbage saved", () => {
    expect(normalizeLayout(null, DEFAULTS)).toEqual({ order: [...DEFAULTS], hidden: [] });
    expect(normalizeLayout({ order: "x", hidden: [1, 2] }, DEFAULTS)).toEqual({ order: [...DEFAULTS], hidden: [] });
  });

  it("keeps a saved order, dropping unknown columns and adding new ones by their default neighbour", () => {
    expect(normalizeLayout({ order: ["price", "gone", "status", "item", "expires"], hidden: ["item", "gone"] }, DEFAULTS)).toEqual({
      order: ["price", "status", "corp", "item", "expires"],
      hidden: ["item"],
    });
  });

  it("keeps columns absent from this view when asked, for tables whose columns follow filters", () => {
    expect(normalizeLayout({ order: ["price", "fees", "status"], hidden: ["fees"] }, DEFAULTS, { keepUnknown: true })).toEqual({
      order: ["price", "expires", "fees", "status", "corp", "item"],
      hidden: ["fees"],
    });
  });

  it("never hides every column", () => {
    expect(normalizeLayout({ order: [], hidden: [...DEFAULTS] }, DEFAULTS).hidden).toEqual([]);
    const one: Key[] = ["status", "corp", "item", "price"];
    const layout = { order: [...DEFAULTS], hidden: one };
    expect(toggleColumn(layout, "expires", DEFAULTS)).toBe(layout);
    expect(toggleColumn(layout, "item", DEFAULTS).hidden).toEqual(["status", "corp", "price"]);
  });

  it("only counts available columns when hiding", () => {
    // Corp is not on the table (no character shares), so hiding status would leave nothing but corp.
    const layout = { order: [...DEFAULTS], hidden: ["item", "price", "expires"] as Key[] };
    expect(toggleColumn(layout, "status", ["status", "item", "price", "expires"])).toBe(layout);
  });

  it("moves a column onto another's place, or one visible step", () => {
    const order: Key[] = [...DEFAULTS];
    expect(moveColumn(order, "price", "status")).toEqual(["price", "status", "corp", "item", "expires"]);
    expect(moveColumn(order, "status", "price")).toEqual(["corp", "item", "price", "status", "expires"]);
    // Corp hidden: stepping item left jumps over it.
    expect(stepColumn(order, ["status", "item", "price", "expires"], "item", -1)).toEqual(["item", "status", "corp", "price", "expires"]);
    expect(stepColumn(order, [...DEFAULTS], "expires", 1)).toBe(order);
  });
});
