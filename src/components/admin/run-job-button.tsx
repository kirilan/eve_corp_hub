"use client";

import { useActionState } from "react";
import type { FormState } from "@/app/(fittings)/fittings/actions";

/** "Run now" for one scheduled job. `run` is the Server Action already bound to the job's path. */
export function RunJobButton({ run, running }: { run: (state: FormState) => Promise<FormState>; running: boolean }) {
  const [state, action, pending] = useActionState<FormState>(run, {});
  return (
    <form action={action} className="flex flex-wrap items-center gap-2">
      <button
        disabled={pending || running}
        className="rounded border border-border px-2.5 py-1 text-xs hover:border-accent disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? "Running… (can take a few minutes)" : running ? "Running" : "Run now"}
      </button>
      {!pending && state.error && <span className="text-xs text-red-300">{state.error}</span>}
      {!pending && state.ok && <span className="text-xs text-emerald-300">{state.ok}</span>}
    </form>
  );
}
