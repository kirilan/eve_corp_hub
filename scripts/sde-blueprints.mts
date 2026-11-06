/**
 * Regenerates src/lib/industry/blueprints.json, the industry recipes trade performance costs built
 * items with, from CCP's static data export. ESI never lists what a job consumed, so the recipe has to
 * come from the SDE; it ships with the code and changes only with game patches.
 *
 *   1. Download the JSONL export: https://developers.eveonline.com/static-data
 *      (eve-online-static-data-latest-jsonl.zip, about 100 MB).
 *   2. Unzip _sde.jsonl, blueprints.jsonl, types.jsonl and typeDogma.jsonl into one folder.
 *   3. pnpm sde:blueprints <that folder>
 *
 * Same data and rules as eve-skills' blueprint_materials.json and blueprint_invention.json.
 */
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

// "Decryptors - Generic": the eight decryptors invention accepts.
const DECRYPTOR_GROUP = 1304;
// inventionPropabilityMultiplier (CCP's spelling), ME, TE and max-runs modifiers.
const ATTR_PROBABILITY = 1112;
const ATTR_ME = 1113;
const ATTR_TE = 1114;
const ATTR_RUNS = 1124;
const OUT = path.join(import.meta.dirname, "../src/lib/industry/blueprints.json");

async function* rows<T>(dir: string, file: string): AsyncGenerator<T> {
  const lines = createInterface({ input: createReadStream(path.join(dir, file)), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) yield JSON.parse(line) as T;
}

type Quantity = { typeID: number; quantity: number; probability?: number };
type Activity = { materials?: Quantity[]; products?: Quantity[] };
type SdeBlueprint = { _key: number; activities?: Record<string, Activity> };
type SdeType = { _key: number; groupID: number; name: { en: string } };
type SdeDogma = { _key: number; dogmaAttributes?: { attributeID: number; value: number }[] };

/** [product, units per run, material, quantity, material, quantity, ...] */
type Recipe = number[];

function recipe(activity: Activity | undefined): Recipe | null {
  const product = activity?.products?.[0];
  if (!activity || !product || activity.products!.length !== 1) return null;
  return [product.typeID, product.quantity, ...(activity.materials ?? []).flatMap((m) => [m.typeID, m.quantity])];
}

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: pnpm sde:blueprints <folder with the unzipped SDE .jsonl files>");

  let sde: { buildNumber: number; releaseDate: string } | undefined;
  for await (const row of rows<{ _key: string; buildNumber: number; releaseDate: string }>(dir, "_sde.jsonl")) if (row._key === "sde") sde = row;
  if (!sde) throw new Error("_sde.jsonl has no build number");

  const manufacturing: Record<string, Recipe> = {};
  const reaction: Record<string, Recipe> = {};
  // Keyed by the blueprint invented from: [data cores per attempt as [type, quantity, ...], [[invented blueprint, runs, chance], ...]].
  const invention: Record<string, [number[], [number, number, number][]]> = {};
  for await (const row of rows<SdeBlueprint>(dir, "blueprints.jsonl")) {
    const activities = row.activities ?? {};
    const built = recipe(activities.manufacturing);
    if (built) manufacturing[row._key] = built;
    const reacted = recipe(activities.reaction);
    if (reacted) reaction[row._key] = reacted;
    const invent = activities.invention;
    if (invent?.products?.length) {
      invention[row._key] = [
        (invent.materials ?? []).flatMap((m) => [m.typeID, m.quantity]),
        invent.products.map((p) => [p.typeID, p.quantity, p.probability ?? 0]),
      ];
    }
  }

  const decryptorNames = new Map<number, string>();
  for await (const type of rows<SdeType>(dir, "types.jsonl")) if (type.groupID === DECRYPTOR_GROUP) decryptorNames.set(type._key, type.name.en);
  // [ME modifier, TE modifier, extra runs, probability multiplier, name]
  const decryptors: Record<string, [number, number, number, number, string]> = {};
  for await (const row of rows<SdeDogma>(dir, "typeDogma.jsonl")) {
    const name = decryptorNames.get(row._key);
    if (!name) continue;
    const value = new Map((row.dogmaAttributes ?? []).map((a) => [a.attributeID, a.value]));
    if (![ATTR_PROBABILITY, ATTR_ME, ATTR_TE, ATTR_RUNS].every((id) => value.has(id))) continue;
    decryptors[row._key] = [value.get(ATTR_ME)!, value.get(ATTR_TE)!, value.get(ATTR_RUNS)!, value.get(ATTR_PROBABILITY)!, name];
  }
  if (Object.keys(decryptors).length === 0) throw new Error("no decryptors found: has the decryptor group or its dogma changed?");

  const data = { sde: { buildNumber: sde.buildNumber, releaseDate: sde.releaseDate }, manufacturing, reaction, invention, decryptors };
  await writeFile(OUT, JSON.stringify(data) + "\n");
  console.log(
    `SDE build ${sde.buildNumber}: ${Object.keys(manufacturing).length} manufacturing and ${Object.keys(reaction).length} reaction ` +
      `recipes, ${Object.keys(invention).length} invention rows, ${Object.keys(decryptors).length} decryptors -> ${path.relative(process.cwd(), OUT)}`,
  );
}

await main();
