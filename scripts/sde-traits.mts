/**
 * Regenerates src/lib/fittings/ship-traits.json, the ship bonuses a fit's page shows under the hull,
 * from CCP's static data export. ESI does not serve ship traits; they ship with the code and change
 * only with game patches.
 *
 *   1. Download the JSONL export: https://developers.eveonline.com/static-data
 *      (eve-online-static-data-latest-jsonl.zip, about 100 MB).
 *   2. Unzip _sde.jsonl, typeBonus.jsonl, types.jsonl and dogmaUnits.jsonl into one folder.
 *   3. pnpm sde:traits <that folder>
 *
 * English text only, markup stripped (the SDE links skills and modules with <a href=showinfo:…>).
 */
import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

const OUT = path.join(import.meta.dirname, "../src/lib/fittings/ship-traits.json");

async function* rows<T>(dir: string, file: string): AsyncGenerator<T> {
  const lines = createInterface({ input: createReadStream(path.join(dir, file)), crlfDelay: Infinity });
  for await (const line of lines) if (line.trim()) yield JSON.parse(line) as T;
}

type Text = { en?: string };
type SdeBonus = { bonus?: number; bonusText: Text; importance?: number; unitID?: number };
type SdeTraits = { _key: number; types?: { _key: number; _value: SdeBonus[] }[]; roleBonuses?: SdeBonus[]; miscBonuses?: SdeBonus[] };
type SdeType = { _key: number; name: Text };
type SdeUnit = { _key: number; displayName?: Text };

/** [amount as shown in game, or "" when the bonus has none, text] */
type Bonus = [string, string];

const plain = (html: string) => html.replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();

function amount(bonus: SdeBonus, units: Map<number, string>): string {
  if (bonus.bonus === undefined) return "";
  const value = Number(bonus.bonus.toFixed(2)).toString();
  const unit = bonus.unitID === undefined ? "" : (units.get(bonus.unitID) ?? "");
  // How the game's Traits tab writes them: "7.5%", "+1", "5x", "2000 m".
  if (unit === "%" || unit === "x") return `${value}${unit}`;
  if (unit === "+") return `+${value}`;
  return unit ? `${value} ${unit}` : value;
}

function bonuses(list: SdeBonus[] | undefined, units: Map<number, string>): Bonus[] {
  return [...(list ?? [])]
    .sort((a, b) => (a.importance ?? 0) - (b.importance ?? 0))
    .map((bonus) => [amount(bonus, units), plain(bonus.bonusText.en ?? "")] as Bonus)
    .filter(([, text]) => text);
}

async function main() {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: pnpm sde:traits <folder with the unzipped SDE .jsonl files>");

  let sde: { buildNumber: number; releaseDate: string } | undefined;
  for await (const row of rows<{ _key: string; buildNumber: number; releaseDate: string }>(dir, "_sde.jsonl")) if (row._key === "sde") sde = row;
  if (!sde) throw new Error("_sde.jsonl has no build number");

  const units = new Map<number, string>();
  for await (const unit of rows<SdeUnit>(dir, "dogmaUnits.jsonl")) if (unit.displayName?.en) units.set(unit._key, unit.displayName.en);

  const traits: SdeTraits[] = [];
  for await (const row of rows<SdeTraits>(dir, "typeBonus.jsonl")) traits.push(row);
  const skillIds = new Set(traits.flatMap((row) => (row.types ?? []).map((skill) => skill._key)));
  const skillNames = new Map<number, string>();
  for await (const type of rows<SdeType>(dir, "types.jsonl")) if (skillIds.has(type._key) && type.name.en) skillNames.set(type._key, type.name.en);

  // Keyed by ship type: [[skill name, bonuses per level], ...], role bonuses, misc bonuses.
  const ships: Record<string, { skills: [string, Bonus[]][]; role: Bonus[]; misc: Bonus[] }> = {};
  for (const row of traits) {
    const skills = (row.types ?? [])
      .map((skill) => [skillNames.get(skill._key) ?? `Skill ${skill._key}`, bonuses(skill._value, units)] as [string, Bonus[]])
      .filter(([, list]) => list.length > 0);
    const role = bonuses(row.roleBonuses, units);
    const misc = bonuses(row.miscBonuses, units);
    if (skills.length || role.length || misc.length) ships[row._key] = { skills, role, misc };
  }
  if (!ships[587]?.skills.length) throw new Error("no Rifter bonuses found: has typeBonus.jsonl changed shape?");

  await writeFile(OUT, JSON.stringify({ sde: { buildNumber: sde.buildNumber, releaseDate: sde.releaseDate }, ships }) + "\n");
  console.log(`SDE build ${sde.buildNumber}: bonuses for ${Object.keys(ships).length} ships -> ${path.relative(process.cwd(), OUT)}`);
}

await main();
