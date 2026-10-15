"use client";

import { useActionState } from "react";
import { saveFit, type FormState } from "@/app/fittings/actions";
import type { Visibility } from "@/lib/fittings/store";
import { VISIBILITY_LABEL } from "./visibility-badge";

const HINT: Record<Visibility, string> = {
  private: "Only you.",
  corporation: "Members whose main is in your main's corporation.",
  link: "Anyone you give the link to. Not listed anywhere.",
  public: "Everyone, listed in the public library.",
};

export function FitForm({
  fitId = null,
  initial,
  canShareWithCorporation,
}: {
  fitId?: string | null;
  initial?: { eft: string; name: string; description: string; visibility: Visibility };
  canShareWithCorporation: boolean;
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(saveFit.bind(null, fitId), {});
  return (
    <form action={action} className="space-y-5">
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">Fit (EFT)</span>
        <textarea
          name="eft"
          required
          rows={16}
          defaultValue={initial?.eft}
          placeholder={"[Rifter, Fast tackle]\nDamage Control II\n..."}
          className="w-full rounded border border-border bg-background p-3 font-mono text-sm"
        />
        <span className="block text-xs text-muted">
          In EVE, copy a fit to the clipboard from the fitting window, or export it from Pyfa, and paste it here.
        </span>
      </label>
      <div className="grid gap-5 sm:grid-cols-2">
        <label className="block space-y-1.5">
          <span className="text-sm font-medium">Name</span>
          <input
            name="name"
            maxLength={50}
            defaultValue={initial?.name}
            placeholder="Taken from the EFT header if empty"
            className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
          />
        </label>
        <fieldset className="space-y-1.5">
          <legend className="text-sm font-medium">Who can see it</legend>
          {(Object.keys(HINT) as Visibility[]).map((visibility) => (
            <label key={visibility} className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="visibility"
                value={visibility}
                defaultChecked={(initial?.visibility ?? "private") === visibility}
                disabled={visibility === "corporation" && !canShareWithCorporation}
                className="mt-1"
              />
              <span>
                {VISIBILITY_LABEL[visibility]} <span className="text-muted">— {HINT[visibility]}</span>
              </span>
            </label>
          ))}
        </fieldset>
      </div>
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">Description</span>
        <textarea
          name="description"
          rows={3}
          maxLength={500}
          defaultValue={initial?.description}
          className="w-full rounded border border-border bg-background p-3 text-sm"
        />
      </label>
      {state.error && (
        <p role="alert" className="rounded border border-red-800/70 bg-red-950/40 px-4 py-3 text-sm">
          {state.error}
        </p>
      )}
      <button disabled={pending} className="rounded bg-accent px-5 py-2 font-medium text-black hover:brightness-110 disabled:opacity-60">
        {pending ? "Saving…" : "Save fit"}
      </button>
    </form>
  );
}
