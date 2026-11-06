/**
 * Reads a pasted item list. A line can be read more than one way ("Tritanium 1000" could be an item
 * of that name), so each line yields its readings in order of preference, and the first one whose
 * name EVE knows wins. Understood:
 *   - EVE inventory, assets and contract lists: tab-separated, name then quantity (blank means 1)
 *   - "Warrior II x5", "5x Warrior II", "5 x Warrior II"
 *   - "Tritanium 1000", "1000 Tritanium"
 *   - EFT fits: the hull from the header, modules (loaded charges dropped), "[Empty …]" skipped
 */

export type Reading = { name: string; quantity: number };
export type ParsedLine = { line: string; readings: Reading[] };

// The longest item name in the game is 89 characters; longer "names" are prose, not worth asking ESI about.
const MAX_NAME = 100;
// 1234, or 1,234 / 1.234 / 1 234 / 1'234 as EVE writes thousands in different languages.
const QUANTITY = /^(?:\d{1,3}(?:[,.' \u00a0\u202f]\d{3})+|\d+)$/;
const Q = String.raw`(\d{1,3}(?:[,.' \u00a0\u202f]\d{3})+|\d+)`;
const SUFFIX = new RegExp(String.raw`^(.+?)\s+[x×]\s*${Q}$`, "i");
const PREFIX = new RegExp(String.raw`^${Q}\s*[x×]\s+(.+)$`, "i");
const TRAILING = new RegExp(String.raw`^(.+?)\s+${Q}$`);
const LEADING = new RegExp(String.raw`^${Q}\s+(.+)$`);

export function quantityOf(text: string): number | null {
  const trimmed = text.trim();
  if (!QUANTITY.test(trimmed)) return null;
  const value = Number(trimmed.replace(/\D/g, ""));
  return value > 0 && Number.isSafeInteger(value) ? value : null;
}

function readingsOf(raw: string): Reading[] {
  // EFT: "[Rifter, Fast tackle]" names the hull; "[Empty Low slot]" and the like are placeholders.
  const header = /^\[([^,\]]+),.*\]$/.exec(raw);
  if (header) return [{ name: header[1].trim(), quantity: 1 }];
  if (/^\[.*\]$/.test(raw)) return [];

  const columns = raw.split("\t").map((column) => column.trim());
  if (columns.length > 1) {
    const [first, second] = columns;
    if (second === "") return [{ name: first, quantity: 1 }];
    const quantity = quantityOf(second);
    if (quantity !== null) return [{ name: first, quantity }];
    const leading = quantityOf(first);
    if (leading !== null) return [{ name: second, quantity: leading }];
    return [{ name: first, quantity: 1 }];
  }

  const line = raw.replace(/\s+\/offline$/i, "");
  const out: Reading[] = [{ name: line, quantity: 1 }];
  const add = (match: RegExpExecArray | null, nameAt: number, quantityAt: number) => {
    const quantity = match && quantityOf(match[quantityAt]);
    if (match && quantity) out.push({ name: match[nameAt].trim(), quantity });
  };
  add(SUFFIX.exec(line), 1, 2);
  add(PREFIX.exec(line), 2, 1);
  // EFT module with a loaded charge: "200mm AutoCannon II, EMP S".
  const comma = line.indexOf(", ");
  if (comma > 0) out.push({ name: line.slice(0, comma), quantity: 1 });
  add(TRAILING.exec(line), 1, 2);
  add(LEADING.exec(line), 2, 1);
  return out;
}

export function parseItemList(text: string): ParsedLine[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .map((line) => ({ line, readings: readingsOf(line).filter((reading) => reading.name !== "" && reading.name.length <= MAX_NAME) }))
    .filter((parsed) => parsed.readings.length > 0 || !/^\[.*\]$/.test(parsed.line));
}
