import "server-only";
import { deadlineSignal, OPERATION_TIMEOUT_MS } from "@/lib/eve/deadline";
import { typeNames, typesByName } from "@/lib/eve/types";
import { type Hub } from "./hubs";
import { hubPrices } from "./market";
import { ORE_SKILL_NAMES, reprocessing } from "./materials";
import { parseItemList } from "./parse";
import type { Appraisal, AppraisalItem, Book } from "./reprocess";

export class AppraisalError extends Error {}

export const MAX_INPUT_CHARS = 100_000;
export const MAX_ITEM_TYPES = 500;
export const MAX_INPUT_LINES = 500;
export const MAX_CANDIDATE_NAMES = 1500;
const MAX_UNKNOWN_SHOWN = 50;

/**
 * Reads a pasted item list and looks up everything the calculator needs: each item's reprocessing
 * materials, and order books at the hub for the items and their materials. The figures themselves are
 * worked out in the browser (`appraise`), so the price basis and tax can change without a round trip.
 */
export async function appraiseItems(viewerId: string, text: string, hub: Hub): Promise<Appraisal> {
  if (text.length > MAX_INPUT_CHARS) throw new AppraisalError(`That list is too long: paste at most ${MAX_INPUT_CHARS.toLocaleString("en-US")} characters at a time.`);
  const lines = parseItemList(text);
  if (lines.length === 0) throw new AppraisalError("Paste at least one item.");

  if (lines.length > MAX_INPUT_LINES) throw new AppraisalError(`Paste at most ${MAX_INPUT_LINES} item lines at a time.`);
  const candidates = [...new Set(lines.flatMap((line) => line.readings.map((reading) => reading.name.toLowerCase())))];
  if (candidates.length > MAX_CANDIDATE_NAMES) throw new AppraisalError("Too many possible item names; split the list into smaller batches.");
  const signal = deadlineSignal(OPERATION_TIMEOUT_MS);
  const types = await typesByName(candidates, signal);
  const quantities = new Map<number, number>();
  const unknown: string[] = [];
  for (const line of lines) {
    const match = line.readings.find((reading) => types.has(reading.name.toLowerCase()));
    if (!match) {
      unknown.push(line.line);
      continue;
    }
    const typeId = types.get(match.name.toLowerCase())!.id;
    quantities.set(typeId, (quantities.get(typeId) ?? 0) + match.quantity);
  }
  if (quantities.size === 0) throw new AppraisalError("None of those lines name an EVE item. Copy items from an inventory window, or write one per line, like “Warrior II x5”.");
  if (quantities.size > MAX_ITEM_TYPES) throw new AppraisalError(`That list has ${quantities.size} different items; appraise at most ${MAX_ITEM_TYPES} at a time.`);

  const names = new Map([...types.values()].map((type) => [type.id, type.name]));
  const items: AppraisalItem[] = [...quantities].map(([typeId, quantity]) => ({
    typeId,
    name: names.get(typeId)!,
    quantity,
    reprocess: reprocessing(typeId),
  }));

  const materialIds = [...new Set(items.flatMap((item) => item.reprocess?.materials.map(([typeId]) => typeId) ?? []))];
  const oreSkills = [...new Set(items.map((item) => item.reprocess?.oreSkill).filter((skill) => skill != null))];
  const materialNames = await typeNames(materialIds, signal);
  const prices = await hubPrices(hub, [...quantities.keys(), ...materialIds], viewerId, signal);

  return {
    hub,
    items,
    materialNames: Object.fromEntries(materialNames),
    oreSkillNames: Object.fromEntries(oreSkills.map((skill) => [skill, ORE_SKILL_NAMES[skill] ?? `Skill ${skill}`])),
    books: trimmedBooks(items, prices.books),
    unknown: unknown.slice(0, MAX_UNKNOWN_SHOWN),
    pricesAsOf: prices.asOf?.toISOString() ?? null,
    pricesAvailable: prices.available,
    warnings: [...prices.warnings, ...(unknown.length > MAX_UNKNOWN_SHOWN ? [`${unknown.length - MAX_UNKNOWN_SHOWN} more lines were not recognised.`] : [])],
  };
}

/**
 * Only as much of each book as the page can use: buy levels down to where the most units any option
 * could sell are filled (reprocessing at a full 100%, more than any skills reach), and the single best
 * sell order.
 */
function trimmedBooks(items: AppraisalItem[], books: Map<number, Book>): Record<number, Book> {
  const most = new Map<number, number>();
  const add = (typeId: number, units: number) => most.set(typeId, (most.get(typeId) ?? 0) + units);
  for (const item of items) {
    add(item.typeId, item.quantity);
    if (!item.reprocess) continue;
    const portions = Math.floor(item.quantity / item.reprocess.portionSize);
    for (const [typeId, perPortion] of item.reprocess.materials) add(typeId, perPortion * portions);
  }
  const out: Record<number, Book> = {};
  for (const [typeId, book] of books) {
    const need = most.get(typeId) ?? 0;
    const buy = [];
    let units = 0;
    for (const level of book.buy) {
      if (units >= need) break;
      buy.push(level);
      units += level[1];
    }
    out[typeId] = { buy, sell: book.sell.slice(0, 1) };
  }
  return out;
}
