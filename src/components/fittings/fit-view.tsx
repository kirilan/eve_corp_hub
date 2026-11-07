import Image from "next/image";
import type { FittingItem } from "@/db/schema";
import { typeNames } from "@/lib/eve/types";
import { sectionsOf, toEft, type SlotKind } from "@/lib/fittings/eft";
import type { FitRow } from "@/lib/fittings/store";
import { CopyButton } from "./copy-button";
import { typeIconUrl } from "@/lib/eve/images";
import { shipTraits, type ShipBonus, type ShipTraits } from "@/lib/fittings/traits";

const SLOT_LABEL: Record<SlotKind, string> = {
  hi: "High slots",
  med: "Mid slots",
  lo: "Low slots",
  rig: "Rigs",
  subsystem: "Subsystems",
  service: "Service slots",
};
// Reading order in game: highs on top.
const DISPLAY_ORDER: SlotKind[] = ["hi", "med", "lo", "rig", "subsystem", "service"];

function ItemRow({ item, name, showQuantity }: { item: FittingItem; name: string; showQuantity: boolean }) {
  return (
    <li className="flex items-center gap-2 py-1">
      <Image src={typeIconUrl(item.type_id)} alt="" width={24} height={24} unoptimized className="rounded-sm" />
      <span>{name}</span>
      {showQuantity && <span className="text-muted">× {item.quantity.toLocaleString("en")}</span>}
    </li>
  );
}

function BonusList({ title, bonuses }: { title: string; bonuses: ShipBonus[] }) {
  return (
    <div>
      <h4 className="text-xs text-muted">{title}</h4>
      <ul className="mt-0.5 space-y-0.5">
        {bonuses.map(([amount, text], i) => (
          <li key={i} className="flex gap-2">
            {amount && <span className="w-12 shrink-0 text-right font-mono text-accent">{amount}</span>}
            <span className={amount ? "" : "pl-14"}>{text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The hull's bonuses, laid out like the game's Traits tab. */
function Traits({ traits }: { traits: ShipTraits }) {
  return (
    <section className="space-y-2 text-xs">
      <h3 className="font-semibold tracking-wider text-muted uppercase">Bonuses</h3>
      {traits.skills.map(([skill, bonuses]) => (
        <BonusList key={skill} title={`${skill} bonuses (per skill level)`} bonuses={bonuses} />
      ))}
      {traits.role.length > 0 && <BonusList title="Role bonus" bonuses={traits.role} />}
      {traits.misc.length > 0 && <BonusList title="Misc bonus" bonuses={traits.misc} />}
    </section>
  );
}

export async function FitView({ fit }: { fit: Pick<FitRow, "name" | "description" | "shipTypeId" | "items"> }) {
  const names = await typeNames([fit.shipTypeId, ...fit.items.map((item) => item.type_id)]);
  const name = (id: number) => names.get(id) ?? `Type ${id}`;
  const sections = sectionsOf(fit.items);
  const eft = toEft(fit, names);
  const traits = shipTraits(fit.shipTypeId);
  const bays: [string, FittingItem[]][] = [
    ["Drones", sections.drones],
    ["Fighters", sections.fighters],
    ["Cargo", sections.cargo],
  ];

  return (
    <div className="grid gap-6 md:grid-cols-[256px_1fr]">
      <div className="space-y-3">
        <Image
          src={`https://images.evetech.net/types/${fit.shipTypeId}/render?size=256`}
          alt={name(fit.shipTypeId)}
          width={256}
          height={256}
          unoptimized
          className="rounded border border-border"
        />
        {traits && <Traits traits={traits} />}
        {fit.description && <p className="whitespace-pre-wrap text-sm text-muted">{fit.description}</p>}
      </div>
      <div className="space-y-5">
        {DISPLAY_ORDER.filter((kind) => sections.slots[kind].length > 0).map((kind) => (
          <section key={kind}>
            <h3 className="text-xs font-semibold tracking-wider text-muted uppercase">{SLOT_LABEL[kind]}</h3>
            <ul>
              {sections.slots[kind].map(({ item }) => (
                <ItemRow key={item.flag} item={item} name={name(item.type_id)} showQuantity={false} />
              ))}
            </ul>
          </section>
        ))}
        {bays
          .filter(([, items]) => items.length > 0)
          .map(([label, items]) => (
            <section key={label}>
              <h3 className="text-xs font-semibold tracking-wider text-muted uppercase">{label}</h3>
              <ul>
                {items.map((item) => (
                  <ItemRow key={`${item.flag}-${item.type_id}`} item={item} name={name(item.type_id)} showQuantity />
                ))}
              </ul>
            </section>
          ))}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold tracking-wider text-muted uppercase">EFT</h3>
            <CopyButton text={eft} label="Copy EFT" />
          </div>
          <pre className="max-h-72 overflow-auto rounded border border-border bg-background p-3 font-mono text-xs">{eft}</pre>
          <p className="text-xs text-muted">EVE&apos;s fitting window can import this text from the clipboard.</p>
        </section>
      </div>
    </div>
  );
}
