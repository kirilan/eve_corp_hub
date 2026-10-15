"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/fittings/actions";

/** Name + description form shared by "new doctrine" and "edit doctrine". */
export function DoctrineForm({
  action,
  initial,
  submit,
}: {
  action: (state: FormState, form: FormData) => Promise<FormState>;
  initial?: { name: string; description: string };
  submit: string;
}) {
  const [state, formAction, pending] = useActionState(action, {});
  return (
    <form action={formAction} className="space-y-3">
      <input
        name="name"
        required
        maxLength={80}
        defaultValue={initial?.name}
        placeholder="Doctrine name, e.g. Armor Ishtars"
        className="w-full rounded border border-border bg-background px-3 py-2 text-sm"
      />
      <textarea
        name="description"
        rows={3}
        maxLength={2000}
        defaultValue={initial?.description}
        placeholder="When to fly it, skills needed, who to ask"
        className="w-full rounded border border-border bg-background p-3 text-sm"
      />
      <div className="flex items-center gap-3">
        <button disabled={pending} className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-black hover:brightness-110 disabled:opacity-60">
          {pending ? "Saving…" : submit}
        </button>
        {state.error && <span className="text-sm text-red-300">{state.error}</span>}
        {state.ok && <span className="text-sm text-emerald-300">{state.ok}</span>}
      </div>
    </form>
  );
}
