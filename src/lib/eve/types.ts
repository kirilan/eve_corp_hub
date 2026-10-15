import "server-only";
import { inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { eveTypes } from "@/db/schema";
import type { SlotKind, TypeInfo } from "@/lib/fittings/eft";
import { esi } from "./esi";

// Dogma effects that put a module in a slot (checked against ESI /dogma/effects, 2026-10-15).
const SLOT_EFFECTS: Record<number, SlotKind> = {
  11: "lo",
  12: "hi",
  13: "med",
  2663: "rig",
  3772: "subsystem",
  6306: "service",
};

type EsiType = { type_id: number; name: string; group_id: number; dogma_effects?: { effect_id: number }[] };
type EsiGroup = { group_id: number; category_id: number };

const groupCategory = new Map<number, number>();

async function categoryOf(groupId: number): Promise<number> {
  let category = groupCategory.get(groupId);
  if (category === undefined) {
    category = (await esi<EsiGroup>(`/universe/groups/${groupId}`)).category_id;
    groupCategory.set(groupId, category);
  }
  return category;
}

async function inBatches<T, R>(values: T[], size: number, run: (value: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < values.length; i += size) out.push(...(await Promise.all(values.slice(i, i + size).map(run))));
  return out;
}

function toInfo(row: typeof eveTypes.$inferSelect): TypeInfo {
  return { id: row.id, name: row.name, groupId: row.groupId, categoryId: row.categoryId, slot: row.slot as SlotKind | null };
}

/** Type details by id: from the local table, fetching (and keeping) any it has not seen yet. */
export async function typesById(ids: number[]): Promise<Map<number, TypeInfo>> {
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return new Map();
  const known = await db.select().from(eveTypes).where(inArray(eveTypes.id, wanted));
  const out = new Map(known.map((row) => [row.id, toInfo(row)]));
  const missing = wanted.filter((id) => !out.has(id));
  if (missing.length > 0) {
    const fetched = await inBatches(missing, 10, async (id) => {
      const type = await esi<EsiType>(`/universe/types/${id}`);
      const slot = type.dogma_effects?.map((effect) => SLOT_EFFECTS[effect.effect_id]).find(Boolean) ?? null;
      return { id, name: type.name, groupId: type.group_id, categoryId: await categoryOf(type.group_id), slot };
    });
    await db.insert(eveTypes).values(fetched).onConflictDoNothing();
    for (const type of fetched) out.set(type.id, type);
  }
  return out;
}

/** Type details keyed by lower-cased name; names ESI does not know are simply absent. */
export async function typesByName(names: string[]): Promise<Map<string, TypeInfo>> {
  const wanted = [...new Set(names.map((name) => name.toLowerCase()))];
  if (wanted.length === 0) return new Map();
  const known = await db
    .select()
    .from(eveTypes)
    .where(inArray(sql`lower(${eveTypes.name})`, wanted));
  const out = new Map(known.map((row) => [row.name.toLowerCase(), toInfo(row)]));
  const missing = wanted.filter((name) => !out.has(name));
  for (let i = 0; i < missing.length; i += 500) {
    const { inventory_types = [] } = await esi<{ inventory_types?: { id: number; name: string }[] }>("/universe/ids", {
      method: "POST",
      body: missing.slice(i, i + 500),
    });
    for (const type of (await typesById(inventory_types.map((t) => t.id))).values()) out.set(type.name.toLowerCase(), type);
  }
  return out;
}

export async function typeNames(ids: number[]): Promise<Map<number, string>> {
  return new Map([...(await typesById(ids))].map(([id, type]) => [id, type.name]));
}
