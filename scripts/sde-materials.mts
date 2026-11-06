/**
 * Regenerates src/lib/industry/type-materials.json, the reprocessing table, from CCP's static data
 * export. ESI has no reprocessing data, so it ships with the code and changes only with game patches.
 *
 *   1. Download the JSONL export: https://developers.eveonline.com/static-data
 *      (eve-online-static-data-latest-jsonl.zip, about 100 MB).
 *   2. Unzip _sde.jsonl, types.jsonl, groups.jsonl, typeMaterials.jsonl and typeDogma.jsonl into one folder.
 *   3. pnpm sde:materials <that folder>
 */
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

// Asteroids: ore, ice, moon ore and their compressed forms reprocess on ore skills, not Scrapmetal Processing.
const ASTEROID_CATEGORY = 25;
// Dogma attribute naming the skill that raises a type's reprocessing yield (e.g. Simple Ore Processing).
const REPROCESSING_SKILL = 790;
const OUT = path.join(import.meta.dirname, "../src/lib/industry/type-materials.json");

async function* rows<T>(dir: string, file: string): AsyncGenerator<T> {
  const lines = createInterface({ input: createReadStream(path.join(dir, file)), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) yield JSON.parse(line) as T;
}

type SdeInfo = { buildNumber: number; releaseDate: string };
type SdeType = { _key: number; groupID: number; portionSize?: number; published?: boolean; name: { en: string } };
type SdeGroup = { _key: number; categoryID: number };
type SdeMaterials = { _key: number; materials?: { materialTypeID: number; quantity: number }[] };
type SdeDogma = { _key: number; dogmaAttributes?: { attributeID: number; value: number }[] };

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: pnpm sde:materials <folder with the unzipped SDE .jsonl files>");

  let sde: SdeInfo | undefined;
  for await (const row of rows<SdeInfo & { _key: string }>(dir, "_sde.jsonl")) if (row._key === "sde") sde = row;
  if (!sde) throw new Error("_sde.jsonl has no build number");

  const asteroidGroups = new Set<number>();
  for await (const group of rows<SdeGroup>(dir, "groups.jsonl")) if (group.categoryID === ASTEROID_CATEGORY) asteroidGroups.add(group._key);

  const types = new Map<number, { groupID: number; portionSize?: number; published: boolean }>();
  const names = new Map<number, string>();
  for await (const type of rows<SdeType>(dir, "types.jsonl")) {
    types.set(type._key, { groupID: type.groupID, portionSize: type.portionSize, published: type.published === true });
    names.set(type._key, type.name.en);
  }

  // Only published types with a fixed yield. A handful (some salvage containers) yield random amounts and are left out.
  const out: Record<string, [number, number[]]> = {};
  const ore = new Set<number>();
  for await (const row of rows<SdeMaterials>(dir, "typeMaterials.jsonl")) {
    const type = types.get(row._key);
    if (!type?.published || !row.materials?.length) continue;
    out[row._key] = [type.portionSize ?? 1, row.materials.flatMap((m) => [m.materialTypeID, m.quantity])];
    if (asteroidGroups.has(type.groupID)) ore.add(row._key);
  }

  const oreSkills: Record<string, number> = {};
  for await (const row of rows<SdeDogma>(dir, "typeDogma.jsonl")) {
    if (!ore.has(row._key)) continue;
    const skill = row.dogmaAttributes?.find((a) => a.attributeID === REPROCESSING_SKILL)?.value;
    if (skill === undefined) throw new Error(`ore type ${row._key} names no reprocessing skill`);
    oreSkills[row._key] = skill;
  }
  const missing = [...ore].filter((id) => !(id in oreSkills));
  if (missing.length > 0) throw new Error(`ore types without dogma: ${missing.join(", ")}`);
  const skillNames = Object.fromEntries([...new Set(Object.values(oreSkills))].sort((a, b) => a - b).map((id) => [id, names.get(id) ?? `Skill ${id}`]));

  const data = { sde: { buildNumber: sde.buildNumber, releaseDate: sde.releaseDate }, skillNames, oreSkills, types: out };
  await writeFile(OUT, JSON.stringify(data) + "\n");
  console.log(
    `SDE build ${sde.buildNumber}: ${Object.keys(out).length} reprocessable types, ${ore.size} of them ore and ice ` +
      `on ${Object.keys(skillNames).length} processing skills -> ${path.relative(process.cwd(), OUT)}`,
  );
}

await main();
