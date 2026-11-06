import "server-only";
import { cacheLife } from "next/cache";
import { esi } from "./esi";

/** Item category names (Ship, Module, Charge, ...) by id. They change only with game patches. */
export async function categoryNames(ids: number[]): Promise<Record<number, string>> {
  const wanted = [...new Set(ids)].filter((id) => Number.isSafeInteger(id) && id >= 0).sort((a, b) => a - b);
  const out: Record<number, string> = {};
  await Promise.all(
    wanted.map(async (id) => {
      try {
        out[id] = await cachedCategoryName(id);
      } catch (error) {
        console.warn(`category ${id} lookup failed`, error);
        out[id] = `Category ${id}`;
      }
    }),
  );
  return out;
}

// Failures throw through, so they are never cached.
async function cachedCategoryName(id: number): Promise<string> {
  "use cache";
  cacheLife("days");
  return (await esi<{ name: string }>(`/universe/categories/${id}`)).name;
}
