/**
 * Regenerates src/lib/pvp/comps/static-data.json, the game data the fleet comps pipeline reads killmails
 * with, from CCP's static data export: each solar system's security status (to drop highsec), and each
 * ship, module, charge, drone, subsystem and fighter's group, category, meta group (to flag officer,
 * deadspace and abyssal modules) and base price (the price when ESI has none). It changes only with
 * game patches.
 *
 *   1. Download the JSONL export: https://developers.eveonline.com/static-data
 *      (eve-online-static-data-latest-jsonl.zip, about 100 MB).
 *   2. Unzip _sde.jsonl, types.jsonl, groups.jsonl and mapSolarSystems.jsonl into one folder.
 *   3. pnpm sde:pvp <that folder>
 */
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

// Ship, module, charge, drone, subsystem, fighter: what a killmail's victim flies or has fitted.
const CATEGORIES = new Set([6, 7, 8, 18, 32, 87]);
const OUT = path.join(import.meta.dirname, "../src/lib/pvp/comps/static-data.json");

async function* rows<T>(dir: string, file: string): AsyncGenerator<T> {
  const lines = createInterface({ input: createReadStream(path.join(dir, file)), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) yield JSON.parse(line) as T;
}

type SdeInfo = { buildNumber: number; releaseDate: string };
type SdeType = { _key: number; groupID: number; metaGroupID?: number; basePrice?: number };
type SdeGroup = { _key: number; categoryID: number };
type SdeSystem = { _key: number; securityStatus?: number };

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: pnpm sde:pvp <folder with the unzipped SDE .jsonl files>");

  let sde: SdeInfo | undefined;
  for await (const row of rows<SdeInfo & { _key: string }>(dir, "_sde.jsonl")) if (row._key === "sde") sde = row;
  if (!sde) throw new Error("_sde.jsonl has no build number");

  const categoryOf = new Map<number, number>();
  for await (const group of rows<SdeGroup>(dir, "groups.jsonl")) categoryOf.set(group._key, group.categoryID);

  // typeId -> [group, category, meta group (0 for none), base price in ISK]
  const types: Record<string, [number, number, number, number]> = {};
  for await (const type of rows<SdeType>(dir, "types.jsonl")) {
    const category = categoryOf.get(type.groupID);
    if (category === undefined || !CATEGORIES.has(category)) continue;
    types[type._key] = [type.groupID, category, type.metaGroupID ?? 0, Math.round(type.basePrice ?? 0)];
  }

  // systemId -> security status as the game shows it: one decimal, rounded half up, except that a
  // system just above 0.0 shows as 0.1 (it is lowsec, not nullsec). Highsec is 0.5 and up.
  const systems: Record<string, number> = {};
  for await (const system of rows<SdeSystem>(dir, "mapSolarSystems.jsonl")) {
    const security = system.securityStatus ?? 0;
    systems[system._key] = security > 0 && security < 0.05 ? 0.1 : Math.round(security * 10) / 10;
  }

  const data = { sde: { buildNumber: sde.buildNumber, releaseDate: sde.releaseDate }, systems, types };
  await writeFile(OUT, JSON.stringify(data) + "\n");
  console.log(
    `SDE build ${sde.buildNumber}: ${Object.keys(systems).length} systems, ${Object.keys(types).length} types ` +
      `-> ${path.relative(process.cwd(), OUT)}`,
  );
}

await main();
