"use client";

import Image from "next/image";
import Link from "next/link";
import { useActionState, useState } from "react";
import { bulkSend, type BulkState } from "@/app/fittings/actions";
import { typeIconUrl } from "@/lib/eve/images";
import type { Visibility } from "@/lib/fittings/store";
import { VisibilityBadge } from "./visibility-badge";

export type PickerFit = {
  id: string;
  name: string;
  shipTypeId: number;
  shipName: string | null;
  visibility: Visibility;
  ownerMainName: string | null;
};

const STATUS_STYLE = { sent: "text-emerald-300", skipped: "text-muted", failed: "text-red-300" } as const;

/** A fit list with checkboxes and "send selected to a character". */
export function FitPicker({
  fits,
  characters,
  limit,
  showOwner,
}: {
  fits: PickerFit[];
  characters: { id: number; name: string }[];
  limit: number;
  showOwner: boolean;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [state, action, pending] = useActionState<BulkState, FormData>(bulkSend, {});
  // Selection survives navigation (search, tabs); only fits in the current list count or get sent.
  const selectedCount = fits.filter((fit) => selected.has(fit.id)).length;
  const allSelected = fits.length > 0 && selectedCount === fits.length;
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const results = state.results ?? [];
  const count = (status: "sent" | "skipped" | "failed") => results.filter((r) => r.status === status).length;

  return (
    <form action={action} className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 rounded border border-border bg-surface px-4 py-2.5 text-sm">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={() => setSelected(allSelected ? new Set() : new Set(fits.map((fit) => fit.id)))}
          />
          Select all
        </label>
        <span className="text-muted">{selectedCount} selected</span>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select name="character" className="rounded border border-border bg-background px-2 py-1">
            {characters.map((character) => (
              <option key={character.id} value={character.id}>
                {character.name}
              </option>
            ))}
          </select>
          <button
            disabled={pending || selectedCount === 0 || selectedCount > limit}
            className="rounded border border-border px-3 py-1 hover:border-accent disabled:opacity-50"
          >
            {pending ? "Sending…" : "Send selected to game"}
          </button>
        </div>
        {selectedCount > limit && <p className="w-full text-amber-300">Select at most {limit} fits per send.</p>}
      </div>

      {state.error && <p className="rounded border border-red-800/70 bg-red-950/40 px-4 py-3 text-sm">{state.error}</p>}
      {results.length > 0 && (
        <div role="status" className="space-y-1 rounded border border-border bg-surface px-4 py-3 text-sm">
          <p>
            Sent {count("sent")}, skipped {count("skipped")}, failed {count("failed")}.
          </p>
          <ul>
            {results
              .filter((result) => result.status !== "sent")
              .map((result) => (
                <li key={result.id} className={STATUS_STYLE[result.status]}>
                  {result.name}: {result.status}
                  {result.detail && <> ({result.detail})</>}
                </li>
              ))}
          </ul>
        </div>
      )}

      <ul className="divide-y divide-border rounded border border-border bg-surface">
        {fits.map((fit) => (
          <li key={fit.id} className="flex items-center gap-3 px-4 py-3 hover:bg-white/5">
            <input
              type="checkbox"
              name="fit"
              value={fit.id}
              checked={selected.has(fit.id)}
              onChange={() => toggle(fit.id)}
              aria-label={`Select ${fit.name}`}
            />
            <Link href={`/fittings/${fit.id}`} prefetch={false} className="flex min-w-0 flex-1 items-center gap-3">
              <Image src={typeIconUrl(fit.shipTypeId, 64)} alt="" width={36} height={36} unoptimized className="rounded" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{fit.name}</div>
                <div className="truncate text-sm text-muted">
                  {fit.shipName ?? `Type ${fit.shipTypeId}`}
                  {showOwner && fit.ownerMainName && <> · by {fit.ownerMainName}</>}
                </div>
              </div>
              <VisibilityBadge visibility={fit.visibility} />
            </Link>
          </li>
        ))}
      </ul>
    </form>
  );
}
