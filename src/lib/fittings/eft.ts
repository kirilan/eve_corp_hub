import type { FittingItem } from "@/db/schema";

/**
 * EFT, the text format EVE's fitting window copies to and imports from the clipboard:
 *
 *   [Rifter, Fast tackle]
 *   Damage Control II          <- low slots, then mid, high, rigs, subsystems; blank line between
 *   ...
 *   200mm AutoCannon II, EMP S <- module, loaded charge
 *   [Empty High slot]
 *
 *   Warrior II x5              <- drones, then cargo, each line "Name xQuantity"
 *
 * Section order in the wild is not reliable (tools and hand edits shuffle it), so placement comes
 * from each type's own slot effect, not from which block a line sits in.
 */

export type SlotKind = "hi" | "med" | "lo" | "rig" | "subsystem" | "service";

export type TypeInfo = { id: number; name: string; groupId: number; categoryId: number | null; slot: SlotKind | null };

export const CATEGORY_SHIP = 6;
export const CATEGORY_DRONE = 18;
export const CATEGORY_FIGHTER = 87;

const SLOT_FLAG: Record<SlotKind, string> = {
  lo: "LoSlot",
  med: "MedSlot",
  hi: "HiSlot",
  rig: "RigSlot",
  subsystem: "SubSystemSlot",
  service: "ServiceSlot",
};
// The most ESI's flag enum can express per slot kind.
const SLOT_LIMIT: Record<SlotKind, number> = { lo: 8, med: 8, hi: 8, rig: 3, subsystem: 4, service: 8 };
// EFT's own section order.
export const SLOT_ORDER: SlotKind[] = ["lo", "med", "hi", "rig", "subsystem", "service"];

export class EftError extends Error {}

export type EftLine = { name: string; quantity: number; counted: boolean; charge: string | null; line: number };
export type ParsedEft = { shipName: string; fitName: string; lines: EftLine[] };

export function parseEft(text: string): ParsedEft {
  const rows = text.replace(/\r\n?/g, "\n").split("\n");
  const headerIndex = rows.findIndex((row) => row.trim() !== "");
  const header = /^\[([^,\]]+),\s*(.*)\]$/.exec(rows[headerIndex]?.trim() ?? "");
  if (!header) throw new EftError('The first line must look like "[Ship type, Fit name]".');
  const shipName = header[1].trim();
  const fitName = header[2].trim();

  const lines: EftLine[] = [];
  rows.forEach((raw, index) => {
    if (index <= headerIndex) return;
    let row = raw.trim();
    if (row === "" || /^\[empty .* slot\]$/i.test(row)) return;
    row = row.replace(/\s*\/offline$/i, "");
    let quantity = 1;
    let counted = false;
    const count = /^(.*\S)\s+x(\d+)$/i.exec(row);
    if (count) {
      row = count[1];
      quantity = Number(count[2]);
      counted = true;
    }
    const [name, charge] = row.split(",").map((part) => part.trim());
    if (!name) return;
    lines.push({ name, quantity, counted, charge: charge || null, line: index + 1 });
  });
  return { shipName, fitName, lines };
}

/** Every type name the parsed fit mentions, ship included: what has to be resolved to ids. */
export function namesIn(parsed: ParsedEft): string[] {
  return [...new Set([parsed.shipName, ...parsed.lines.map((line) => line.name)])];
}

export type BuiltFit = { shipTypeId: number; items: FittingItem[]; warnings: string[] };

/**
 * Places each line: a counted line ("x5") is a drone, fighter or cargo stack; an uncounted line
 * with a slot effect goes into the next free slot of its kind; anything else is cargo.
 * `types` is keyed by lower-cased name.
 */
export function buildFit(parsed: ParsedEft, types: Map<string, TypeInfo>): BuiltFit {
  const ship = types.get(parsed.shipName.toLowerCase());
  if (!ship) throw new EftError(`Unknown ship type "${parsed.shipName}".`);
  if (ship.categoryId !== CATEGORY_SHIP) throw new EftError(`"${ship.name}" is not a ship.`);

  const unknown = parsed.lines.filter((line) => !types.has(line.name.toLowerCase())).map((line) => line.name);
  if (unknown.length > 0) {
    throw new EftError(`Unknown item${unknown.length > 1 ? "s" : ""}: ${[...new Set(unknown)].join(", ")}.`);
  }

  const warnings: string[] = [];
  const used: Record<SlotKind, number> = { lo: 0, med: 0, hi: 0, rig: 0, subsystem: 0, service: 0 };
  const items: FittingItem[] = [];
  const stacks = new Map<string, FittingItem>();
  const stack = (type: TypeInfo, flag: string, quantity: number) => {
    const key = `${flag}:${type.id}`;
    const existing = stacks.get(key);
    if (existing) existing.quantity += quantity;
    else {
      const item = { type_id: type.id, flag, quantity };
      stacks.set(key, item);
      items.push(item);
    }
  };

  for (const line of parsed.lines) {
    const type = types.get(line.name.toLowerCase())!;
    if (!line.counted && type.slot) {
      if (used[type.slot] >= SLOT_LIMIT[type.slot]) {
        throw new EftError(`Too many ${type.slot} slot modules (line ${line.line}: ${type.name}).`);
      }
      items.push({ type_id: type.id, flag: `${SLOT_FLAG[type.slot]}${used[type.slot]++}`, quantity: 1 });
      if (line.charge) {
        warnings.push(`${line.charge} loaded in ${type.name} was left out: EVE fittings carry charges in cargo, not in modules.`);
      }
    } else if (type.categoryId === CATEGORY_DRONE) {
      stack(type, "DroneBay", line.quantity);
    } else if (type.categoryId === CATEGORY_FIGHTER) {
      stack(type, "FighterBay", line.quantity);
    } else {
      stack(type, "Cargo", line.quantity);
    }
  }
  if (items.length === 0) throw new EftError("The fit has no items; EVE does not store empty fittings.");
  return { shipTypeId: ship.id, items, warnings: [...new Set(warnings)] };
}

function slotOf(flag: string): { kind: SlotKind; index: number } | null {
  for (const kind of SLOT_ORDER) {
    const match = new RegExp(`^${SLOT_FLAG[kind]}(\\d)$`).exec(flag);
    if (match) return { kind, index: Number(match[1]) };
  }
  return null;
}

export type FitSections = {
  slots: Record<SlotKind, { index: number; item: FittingItem }[]>;
  drones: FittingItem[];
  fighters: FittingItem[];
  cargo: FittingItem[];
};

export function sectionsOf(items: FittingItem[]): FitSections {
  const sections: FitSections = {
    slots: { lo: [], med: [], hi: [], rig: [], subsystem: [], service: [] },
    drones: [],
    fighters: [],
    cargo: [],
  };
  for (const item of items) {
    const slot = slotOf(item.flag);
    if (slot) sections.slots[slot.kind].push({ index: slot.index, item });
    else if (item.flag === "DroneBay") sections.drones.push(item);
    else if (item.flag === "FighterBay") sections.fighters.push(item);
    else if (item.flag === "Cargo") sections.cargo.push(item);
  }
  for (const kind of SLOT_ORDER) sections.slots[kind].sort((a, b) => a.index - b.index);
  return sections;
}

export function toEft(fit: { name: string; shipTypeId: number; items: FittingItem[] }, names: Map<number, string>): string {
  const name = (id: number) => names.get(id) ?? `Unknown type ${id}`;
  const sections = sectionsOf(fit.items);
  const blocks: string[][] = SLOT_ORDER.map((kind) => sections.slots[kind].map(({ item }) => name(item.type_id))).filter(
    (block) => block.length > 0,
  );
  for (const bay of [sections.drones, sections.fighters, sections.cargo]) {
    if (bay.length > 0) blocks.push(bay.map((item) => `${name(item.type_id)} x${item.quantity}`));
  }
  // The header sits directly on top of the first block; blocks are separated by one blank line.
  return `[${name(fit.shipTypeId)}, ${fit.name}]\n${blocks.map((block) => block.join("\n")).join("\n\n")}\n`;
}

/**
 * Identity of a fit's contents, ignoring which slot number a module sits in, so the same fit saved
 * in game and here compares equal.
 */
export function fitSignature(shipTypeId: number, items: FittingItem[]): string {
  const totals = new Map<string, number>();
  for (const item of items) {
    const slot = slotOf(item.flag);
    const key = `${slot ? slot.kind : item.flag}:${item.type_id}`;
    totals.set(key, (totals.get(key) ?? 0) + item.quantity);
  }
  return `${shipTypeId}|${[...totals].map(([key, quantity]) => `${key}x${quantity}`).sort().join(",")}`;
}

export type ItemChange = { typeId: number; where: string; quantity: number };

function totalsByPlace(items: FittingItem[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const item of items) {
    const where = slotOf(item.flag)?.kind ?? item.flag;
    const key = `${where}:${item.type_id}`;
    totals.set(key, (totals.get(key) ?? 0) + item.quantity);
  }
  return totals;
}

/**
 * What changed between two versions' items, per type and place (slot kind or bay), ignoring slot
 * numbers: moving a module from HiSlot0 to HiSlot2 is not a change.
 */
export function diffItems(before: FittingItem[], after: FittingItem[]): { added: ItemChange[]; removed: ItemChange[] } {
  const a = totalsByPlace(before);
  const b = totalsByPlace(after);
  const added: ItemChange[] = [];
  const removed: ItemChange[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const delta = (b.get(key) ?? 0) - (a.get(key) ?? 0);
    if (delta === 0) continue;
    const [where, typeId] = key.split(":");
    (delta > 0 ? added : removed).push({ typeId: Number(typeId), where, quantity: Math.abs(delta) });
  }
  return { added, removed };
}
