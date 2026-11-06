"use client";

import Link from "next/link";
import { Fragment, startTransition, useActionState, useMemo, useState } from "react";
import { appraise, type AppraiseState, loadCharacter } from "@/app/industry/actions";
import { formatIsk, formatIskExact } from "@/lib/income/format";
import { type Hub, HUB_KEYS, HUBS, hubInfo } from "@/lib/industry/hubs";
import {
  ALL_V,
  type CharacterData,
  defaultSettings,
  fromCharacter,
  fromPercent,
  type HubSettings,
  IMPLANTS,
  oreBaseYield,
  oreYield,
  RIGS,
  type SkillSettings,
  scrapYield,
  STRUCTURES,
  type StructureKind,
} from "@/lib/industry/rates";
import {
  type Appraisal,
  appraise as work,
  type Basis,
  type ItemRow,
  type OptionKey,
  OPTIONS,
  type Result,
  type Yields,
} from "@/lib/industry/reprocess";

export type StructureStatus = { readAt: string | null; error: string | null; readers: number; ownReaders: number };
export type CharacterOption = { id: number; name: string; allowsSkills: boolean };

const BASES: { key: Basis; label: string; hint: string }[] = [
  { key: "buy", label: "Sell now", hint: "Into the hub's buy orders, highest first: sales tax only. A big stack fetches less per unit." },
  { key: "sell", label: "List", hint: "At the hub's lowest sell order, then wait for buyers: sales tax and the broker fee." },
];

const PLACEHOLDER = `Copy items from an inventory window (select them, Ctrl+C), or one per line:
Warrior II x5
Medium Shield Extender II	12
1000 Scourge Heavy Missile`;

const ROMAN = ["Untrained", "I", "II", "III", "IV", "V"];

/** "2026-11-06 13:05 EVE", in EVE time like the rest of the site. */
function eveTime(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")} EVE`;
}

const units = (n: number) => n.toLocaleString("en-US");
const pct = (fraction: number) => `${Number((fraction * 100).toFixed(2))}%`;

function Isk({ value, className = "" }: { value: number; className?: string }) {
  return (
    <span title={formatIskExact(value)} className={`tabular-nums ${className}`}>
      {formatIsk(value)}
    </span>
  );
}

type Who = { id: number | null; character: CharacterData | null; loading: boolean; error?: string };

export function ReprocessCalculator({ structure, characters }: { structure: StructureStatus; characters: CharacterOption[] }) {
  const [state, action, pending] = useActionState<AppraiseState, FormData>(appraise, {});
  const [items, setItems] = useState("");
  const [hub, setHub] = useState<Hub>("jita");
  const [skills, setSkills] = useState<SkillSettings>(ALL_V);
  const [hubs, setHubs] = useState<Record<Hub, HubSettings>>(defaultSettings);
  const [who, setWho] = useState<Who>({ id: null, character: null, loading: false });

  async function pick(value: string) {
    if (value === "") {
      setWho({ id: null, character: null, loading: false });
      setSkills((current) => ({ ...ALL_V, implant: current.implant }));
      setHubs(defaultSettings());
      return;
    }
    const option = characters.find((c) => c.id === Number(value));
    if (!option) return;
    if (!option.allowsSkills) {
      setWho({ id: option.id, character: null, loading: false, error: `${option.name} does not allow reading skills and standings yet.` });
      return;
    }
    setWho({ id: option.id, character: null, loading: true });
    const result = await loadCharacter(option.id);
    const character = result.character;
    if (!character) {
      setWho({ id: option.id, character: null, loading: false, error: result.error });
      return;
    }
    setSkills((current) => fromCharacter(character, { skills: current, hubs: defaultSettings() }).skills);
    setHubs((current) => fromCharacter(character, { skills: ALL_V, hubs: current }).hubs);
    setWho({ id: option.id, character, loading: false });
  }

  return (
    <div className="space-y-8">
      {/* Submitted by hand rather than through the form's action prop: React resets a form after its
          action runs, and the pasted list should stay for the next appraisal. */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          startTransition(() => action(data));
        }}
        className="space-y-4"
      >
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Items</span>
          <textarea
            name="items"
            required
            rows={10}
            value={items}
            onChange={(event) => setItems(event.target.value)}
            placeholder={PLACEHOLDER}
            className="w-full rounded border border-border bg-background p-3 font-mono text-sm"
          />
        </label>
        <div className="flex flex-wrap items-end gap-4">
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Where are the items?</span>
            <select
              name="hub"
              value={hub}
              onChange={(event) => setHub(event.target.value as Hub)}
              className="block rounded border border-border bg-background px-3 py-2 text-sm"
            >
              {HUB_KEYS.map((key) => (
                <option key={key} value={key}>
                  {HUBS[key].label}
                </option>
              ))}
            </select>
          </label>
          <label className="block space-y-1.5">
            <span className="text-sm font-medium">Whose skills and standings?</span>
            <select
              value={who.id ?? ""}
              onChange={(event) => void pick(event.target.value)}
              className="block rounded border border-border bg-background px-3 py-2 text-sm"
            >
              <option value="">Every skill at V, no standings</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.allowsSkills ? "" : " (not allowed)"}
                </option>
              ))}
            </select>
          </label>
          <button disabled={pending} className="rounded bg-accent px-5 py-2 font-medium text-black hover:brightness-110 disabled:opacity-60">
            {pending ? "Reading the market…" : "Appraise"}
          </button>
        </div>
        <div className="space-y-1 text-xs text-muted">
          <p>
            Reprocessed and sold at {HUBS[hub].station}.{HUBS[hub].structure && <StructureNote status={structure} />}
          </p>
          <WhoNote who={who} hub={hub} />
        </div>
      </form>

      <SettingsPanel
        hub={hub}
        skills={skills}
        setSkills={setSkills}
        settings={hubs[hub]}
        setSettings={(change) => setHubs((current) => ({ ...current, [hub]: { ...current[hub], ...change } }))}
        oreSkillNames={state.appraisal?.hub === hub ? state.appraisal.oreSkillNames : {}}
      />

      {state.error && (
        <p role="alert" className="rounded border border-red-800/70 bg-red-950/40 px-4 py-3 text-sm">
          {state.error}
        </p>
      )}
      {state.appraisal && (
        <div aria-busy={pending} className={pending ? "opacity-50" : ""}>
          <Results appraisal={state.appraisal} selectedHub={hub} skills={skills} settings={hubs[state.appraisal.hub]} />
        </div>
      )}
    </div>
  );
}

function StructureNote({ status }: { status: StructureStatus }) {
  const characters = (
    <Link href="/characters" className="text-accent hover:underline">
      Characters
    </Link>
  );
  if (status.readers === 0) {
    return (
      <>
        {" "}
        It is a player structure, so its market can only be read with a character that can dock there. Nobody has allowed
        that yet: on {characters}, choose <em>Allow market reading</em> on such a character.
      </>
    );
  }
  return (
    <>
      {" "}
      A player structure: its market is read with a character that can dock there and allows market reading
      {status.ownReaders === 0 ? " (none of yours do yet; any user's will do)" : ""}.{" "}
      {status.readAt ? `Last read ${eveTime(status.readAt)}; read again when 15 minutes old.` : "Not read yet."}
      {status.error && <span className="text-amber-300"> Last attempt failed: {status.error}.</span>}
    </>
  );
}

function WhoNote({ who, hub }: { who: Who; hub: Hub }) {
  if (who.loading) return <p>Reading skills and standings…</p>;
  if (who.error) {
    return (
      <p className="text-amber-300">
        {who.error} On{" "}
        <Link href="/characters" className="text-accent hover:underline">
          Characters
        </Link>
        , choose <em>Allow skills &amp; standings</em> for it.
      </p>
    );
  }
  if (!who.character) return <p>Rates assume every skill at V and no standings; pick a character to use its own.</p>;
  const info = hubInfo(hub);
  const standing = (id: number) => who.character!.standings[id]?.toFixed(2) ?? "none";
  return (
    <p>
      Skills and rates from {who.character.name}
      {info.structure
        ? `. ${info.label}'s reprocessing tax and broker fee are the owner's: enter them below.`
        : `, standing ${standing(info.owner.id)} with ${info.owner.name} and ${standing(info.faction.id)} with ${info.faction.name}.`}{" "}
      Compare them with the game under <em>Skills, taxes and fees</em>.
    </p>
  );
}

function Level({ label, value, onChange }: { label: string; value: number; onChange: (level: number) => void }) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(Number(event.target.value))} className="rounded border border-border bg-background px-2 py-1 text-sm">
        {ROMAN.map((name, level) => (
          <option key={level} value={level}>
            {name}
          </option>
        ))}
      </select>
    </label>
  );
}

function Percent({ label, hint, value, onChange }: { label: string; hint: string; value: string; onChange: (text: string) => void }) {
  return (
    <label className="block space-y-1 text-sm">
      <span className="flex items-center justify-between gap-3">
        <span>{label}</span>
        <span className="flex items-center gap-1">
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={100}
            step={0.1}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="w-24 rounded border border-border bg-background px-2 py-1 text-right text-sm"
          />
          %
        </span>
      </span>
      <span className="block text-xs text-muted">{hint}</span>
    </label>
  );
}

function Choice<T extends string | number>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm">
      <span>{label}</span>
      <select
        value={value}
        onChange={(event) => onChange(options.find((o) => String(o.value) === event.target.value)!.value)}
        className="max-w-60 rounded border border-border bg-background px-2 py-1 text-sm"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function SettingsPanel({
  hub,
  skills,
  setSkills,
  settings,
  setSettings,
  oreSkillNames,
}: {
  hub: Hub;
  skills: SkillSettings;
  setSkills: (change: (current: SkillSettings) => SkillSettings) => void;
  settings: HubSettings;
  setSettings: (change: Partial<HubSettings>) => void;
  oreSkillNames: Record<number, string>;
}) {
  const info = hubInfo(hub);
  const ore = Object.entries(oreSkillNames).map(([id, name]) => [Number(id), name] as const);
  const set = (change: Partial<SkillSettings>) => setSkills((current) => ({ ...current, ...change }));
  return (
    <details className="rounded border border-border bg-surface p-4">
      <summary className="cursor-pointer text-sm font-medium">
        Skills, taxes and fees at {info.label}
        <span className="font-normal text-muted">
          {" "}
          · Scrapmetal Processing {ROMAN[skills.scrapmetal]} · reprocessing tax {settings.reprocessingTax || 0}% · sales tax{" "}
          {settings.salesTax || 0}% · broker fee {settings.brokerFee || 0}%
        </span>
      </summary>
      <div className="mt-4 grid gap-6 md:grid-cols-2">
        <div className="space-y-2">
          <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Yield</h3>
          <Level label="Scrapmetal Processing" value={skills.scrapmetal} onChange={(scrapmetal) => set({ scrapmetal })} />
          <p className="text-xs text-muted">
            Modules, ships, ammunition and the like: {pct(scrapYield(hub, skills.scrapmetal))}. Rigs and implants do not change it.
          </p>
          {ore.length === 0 ? (
            <p className="text-xs text-muted">Ore and ice skills appear here when the list has ore or ice.</p>
          ) : (
            <>
              <Level label="Reprocessing" value={skills.reprocessing} onChange={(reprocessing) => set({ reprocessing })} />
              <Level label="Reprocessing Efficiency" value={skills.efficiency} onChange={(efficiency) => set({ efficiency })} />
              {ore.map(([id, name]) => (
                <Level
                  key={id}
                  label={name}
                  value={skills.ore[id] ?? skills.otherOre}
                  onChange={(level) => setSkills((current) => ({ ...current, ore: { ...current.ore, [id]: level } }))}
                />
              ))}
              <Choice
                label="Implant"
                value={skills.implant}
                options={IMPLANTS.map((implant, i) => ({ value: i, label: implant.label }))}
                onChange={(implant) => set({ implant })}
              />
              {info.structure && (
                <>
                  <Choice
                    label="Structure"
                    value={settings.structure}
                    options={(Object.keys(STRUCTURES) as StructureKind[]).map((key) => ({ value: key, label: STRUCTURES[key].label }))}
                    onChange={(structure) => setSettings({ structure })}
                  />
                  <Choice
                    label="Reprocessing rig"
                    value={settings.rig}
                    options={RIGS.map((rig, i) => ({ value: i, label: rig.label }))}
                    onChange={(rig) => setSettings({ rig })}
                  />
                </>
              )}
              <p className="text-xs text-muted">
                Ore and ice: {pct(oreBaseYield(hub, settings))} base at this {info.structure ? "structure" : "station"}; with these skills{" "}
                {ore.map(([id, name]) => `${pct(oreYield(hub, settings, skills, id))} on ${name}`).join(", ")}.
              </p>
            </>
          )}
        </div>
        <div className="space-y-3">
          <h3 className="text-xs font-medium tracking-wide text-muted uppercase">Taxes and fees</h3>
          <Percent
            label="Reprocessing tax"
            value={settings.reprocessingTax}
            onChange={(reprocessingTax) => setSettings({ reprocessingTax })}
            hint={
              info.structure
                ? "Set by the structure's owner, from 0%: the structure browser in game shows it."
                : `${pct(info.stationTake)} at no standing with ${info.owner.name}, nothing from 6.67. The reprocessing window shows yours.`
            }
          />
          <Percent
            label="Sales tax"
            value={settings.salesTax}
            onChange={(salesTax) => setSettings({ salesTax })}
            hint="On every sale: 7.5%, less 11% of that per level of Accounting."
          />
          <Percent
            label="Broker fee"
            value={settings.brokerFee}
            onChange={(brokerFee) => setSettings({ brokerFee })}
            hint={
              info.structure
                ? "Only when listing. The owner's rate plus a 0.5% SCC surcharge, 1% at the least; skills do not lower it. The order window shows it."
                : `Only when listing: 3%, less 0.3% per level of Broker Relations and a little per point of standing with ${info.faction.name} and ${info.owner.name}.`
            }
          />
        </div>
      </div>
    </details>
  );
}

function Results({ appraisal, selectedHub, skills, settings }: { appraisal: Appraisal; selectedHub: Hub; skills: SkillSettings; settings: HubSettings }) {
  const [basis, setBasis] = useState<Basis>("buy");
  const hub = HUBS[appraisal.hub];
  const yields = useMemo<Record<OptionKey, Yields>>(
    () => ({
      base: { scrap: scrapYield(appraisal.hub, 0), ore: () => oreBaseYield(appraisal.hub, settings) },
      skills: { scrap: scrapYield(appraisal.hub, skills.scrapmetal), ore: (skill) => oreYield(appraisal.hub, settings, skills, skill) },
    }),
    [appraisal.hub, settings, skills],
  );
  const result = useMemo(
    () =>
      work(
        appraisal,
        { basis, reprocessingTax: fromPercent(settings.reprocessingTax), salesTax: fromPercent(settings.salesTax), brokerFee: fromPercent(settings.brokerFee) },
        yields,
      ),
    [appraisal, basis, settings, yields],
  );
  const oreSkills = Object.keys(appraisal.oreSkillNames).map(Number);
  const hint = (key: OptionKey) => {
    const ores = oreSkills.map((skill) => yields[key].ore(skill));
    const low = Math.min(...ores);
    const high = Math.max(...ores);
    const ore = ores.length === 0 ? "" : ` · ore ${pct(low)}${high > low ? `–${pct(high)}` : ""}`;
    return `Items ${pct(yields[key].scrap)}${ore}`;
  };

  return (
    <section className="space-y-6" aria-label="Appraisal">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Price at {hub.label}</legend>
          <div className="flex gap-2">
            {BASES.map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={basis === option.key}
                title={option.hint}
                onClick={() => setBasis(option.key)}
                className={`rounded border px-3 py-1.5 text-sm ${basis === option.key ? "border-accent text-accent" : "border-border hover:border-foreground"}`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
        <p className="max-w-md text-xs text-muted">{BASES.find((option) => option.key === basis)!.hint}</p>
      </div>

      <div className="space-y-1 text-sm">
        <p className="text-muted">
          {appraisal.pricesAsOf ? `Prices at ${hub.station} as of ${eveTime(appraisal.pricesAsOf)}.` : `No prices at ${hub.station}.`}
          {appraisal.hub !== selectedHub && <span className="text-amber-300"> You changed the location: appraise again for {HUBS[selectedHub].label}.</span>}
        </p>
        {appraisal.warnings.map((warning) => (
          <p key={warning} role="status" className="rounded border border-amber-700/60 bg-amber-950/40 px-3 py-2">
            {warning}
          </p>
        ))}
      </div>

      <OptionCards result={result} priced={appraisal.pricesAvailable} hint={hint} />
      <ItemTable rows={result.items} oreSkillNames={appraisal.oreSkillNames} />
      <MaterialTable result={result} />

      {appraisal.unknown.length > 0 && (
        <details className="rounded border border-border bg-surface p-4 text-sm">
          <summary className="cursor-pointer">
            {appraisal.unknown.length} line{appraisal.unknown.length === 1 ? "" : "s"} not recognised
          </summary>
          <ul className="mt-2 space-y-0.5 font-mono text-xs text-muted">
            {appraisal.unknown.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </details>
      )}

      <ul className="list-disc space-y-1 pl-5 text-xs text-muted">
        <li>Every figure is what reaches the wallet: sales tax comes off every sale, the broker fee off a listing.</li>
        <li>
          The reprocessing tax is counted as that share of the materials&apos; market value. EVE charges it on its own estimate of their
          value, so the real amount differs a little.
        </li>
        <li>Ore and ice reprocess on Reprocessing, Reprocessing Efficiency, their own processing skill and an implant, not Scrapmetal Processing.</li>
        <li>Items reprocess in whole portions (ammunition in 100s, for instance); units short of a portion are counted as sold as they are.</li>
      </ul>
    </section>
  );
}

type Column = { key: "asIs" | OptionKey; label: string };
const COLUMNS: Column[] = [{ key: "asIs", label: "Sell as they are" }, ...OPTIONS.map((option) => ({ key: option.key, label: option.label }))];

function OptionCards({ result, priced, hint }: { result: Result; priced: boolean; hint: (key: OptionKey) => string }) {
  const { totals } = result;
  const value = (key: Column["key"]) => (key === "asIs" ? totals.asIs : totals.options[key]);
  const fees = (key: Column["key"]) => (key === "asIs" ? totals.fees.asIs : totals.fees.options[key]);
  const best = priced ? COLUMNS.reduce((a, b) => (value(b.key) > value(a.key) ? b : a)).key : null;
  return (
    <ul className="grid gap-3 sm:grid-cols-3">
      {COLUMNS.map((column) => {
        const total = value(column.key);
        const delta = total - totals.asIs;
        const mixed = column.key === "asIs" ? 0 : totals.mixed[column.key];
        return (
          <li key={column.key} className={`space-y-2 rounded border bg-surface p-4 ${best === column.key ? "border-accent" : "border-border"}`}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3 className="font-medium">{column.label}</h3>
                <p className="text-xs text-muted">{column.key === "asIs" ? "Every item sold unprocessed" : hint(column.key)}</p>
              </div>
              {best === column.key && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-xs font-medium text-accent">Best</span>}
            </div>
            <p className="text-2xl font-semibold">
              {priced ? (
                <>
                  <Isk value={total} /> <span className="text-base font-normal text-muted">ISK</span>
                </>
              ) : (
                <span className="text-muted">No prices</span>
              )}
            </p>
            {priced && (
              <p className="text-xs text-muted">
                After <Isk value={fees(column.key)} /> of sales tax and fees
              </p>
            )}
            {priced && column.key !== "asIs" && (
              <>
                <p className={`text-sm ${delta >= 0 ? "text-emerald-400" : "text-red-300"}`}>
                  {delta >= 0 ? "+" : "−"}
                  <Isk value={Math.abs(delta)} /> vs selling as they are
                </p>
                {mixed > total + 0.5 && (
                  <p className="text-sm text-muted">
                    Reprocess only the items where it pays: <Isk value={mixed} className="text-foreground" />
                  </p>
                )}
              </>
            )}
            {priced && column.key === "asIs" && totals.notReprocessable > 0 && (
              <p className="text-sm text-muted">
                Every total includes <Isk value={totals.notReprocessable} /> of items that cannot be reprocessed, sold as they are.
              </p>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Flags({ row, oreSkillNames }: { row: ItemRow; oreSkillNames: Record<number, string> }) {
  const notes = [
    !row.reprocessable && "cannot be reprocessed",
    row.oreSkill !== null && (oreSkillNames[row.oreSkill] ?? "ore"),
    row.leftover > 0 && `${units(row.leftover)} short of a portion`,
    row.unpriced && "no price",
    row.partial && "the buy orders take only part of it",
  ].filter(Boolean);
  if (notes.length === 0) return null;
  return <span className="block text-xs text-muted">{notes.join(" · ")}</span>;
}

function ItemTable({ rows, oreSkillNames }: { rows: ItemRow[]; oreSkillNames: Record<number, string> }) {
  const most = (row: ItemRow) => Math.max(row.asIs, ...Object.values(row.options));
  const sorted = [...rows].sort((a, b) => most(b) - most(a));
  const cell = (row: ItemRow, key: Column["key"]) => {
    if (key !== "asIs" && !row.reprocessable) return <span className="text-muted">—</span>;
    const value = key === "asIs" ? row.asIs : row.options[key];
    return <Isk value={value} className={row.best === key && value > 0 ? "font-medium text-accent" : ""} />;
  };
  return (
    <div className="overflow-x-auto rounded border border-border">
      <table className="w-full text-sm">
        <caption className="sr-only">ISK kept for each item, sold as it is or reprocessed</caption>
        <thead className="bg-surface text-left text-xs text-muted">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Item</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Quantity</th>
            {COLUMNS.map((column) => (
              <th key={column.key} scope="col" className="px-3 py-2 text-right font-medium">
                {column.key === "asIs" ? "As they are" : column.key === "base" ? "No skills" : "With skills"}
              </th>
            ))}
            <th scope="col" className="px-3 py-2 font-medium">Better</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border">
          {sorted.map((row) => (
            <tr key={row.typeId}>
              <th scope="row" className="px-3 py-2 text-left font-normal">
                {row.name}
                <Flags row={row} oreSkillNames={oreSkillNames} />
              </th>
              <td className="px-3 py-2 text-right tabular-nums">{units(row.quantity)}</td>
              {COLUMNS.map((column) => (
                <td key={column.key} className="px-3 py-2 text-right">
                  {cell(row, column.key)}
                </td>
              ))}
              <td className="px-3 py-2">{most(row) === 0 ? "—" : row.best === "asIs" ? "Sell" : "Reprocess"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MaterialTable({ result }: { result: Result }) {
  if (result.materials.length === 0) return null;
  const sorted = [...result.materials].sort((a, b) => b.value.skills - a.value.skills);
  return (
    <div className="space-y-2">
      <h3 className="font-medium">Materials from reprocessing everything</h3>
      <div className="overflow-x-auto rounded border border-border">
        <table className="w-full text-sm">
          <caption className="sr-only">Materials each reprocessing option yields, and the ISK they bring</caption>
          <thead className="bg-surface text-left text-xs text-muted">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Material</th>
              {OPTIONS.map((option) => (
                <th key={option.key} scope="col" colSpan={2} className="px-3 py-2 text-right font-medium">
                  {option.key === "base" ? "No skills" : "With skills"}: units · ISK
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sorted.map((row) => (
              <tr key={row.typeId}>
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  {row.name}
                  {(row.unpriced || row.partial) && (
                    <span className="block text-xs text-muted">{row.unpriced ? "no price" : "the buy orders take only part of it"}</span>
                  )}
                </th>
                {OPTIONS.map((option) => (
                  <Fragment key={option.key}>
                    <td className="px-3 py-2 text-right tabular-nums">{units(row.units[option.key])}</td>
                    <td className="px-3 py-2 text-right">
                      <Isk value={row.value[option.key]} />
                    </td>
                  </Fragment>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
