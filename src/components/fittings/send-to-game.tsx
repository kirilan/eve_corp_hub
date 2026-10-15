"use client";

import Link from "next/link";
import { useActionState } from "react";
import { sendFit, type FormState } from "@/app/fittings/actions";

export function SendToGame({
  fitId,
  shareToken,
  characters,
}: {
  fitId: string;
  shareToken: string | null;
  characters: { id: number; name: string }[];
}) {
  const [state, action, pending] = useActionState<FormState, FormData>(sendFit.bind(null, fitId, shareToken), {});
  if (characters.length === 0) {
    return (
      <p className="text-sm text-muted">
        To send fits to the game, allow fitting sync for a character on the{" "}
        <Link href="/characters" className="text-accent hover:underline">
          Characters
        </Link>{" "}
        page.
      </p>
    );
  }
  return (
    <form action={action} className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <select name="character" className="rounded border border-border bg-background px-2 py-1.5 text-sm">
          {characters.map((character) => (
            <option key={character.id} value={character.id}>
              {character.name}
            </option>
          ))}
        </select>
        <button disabled={pending} className="rounded border border-border px-3 py-1.5 text-sm hover:border-accent disabled:opacity-60">
          {pending ? "Sending…" : "Send to game"}
        </button>
      </div>
      {state.error && <p className="text-sm text-red-300">{state.error}</p>}
      {state.ok && <p className="text-sm text-emerald-300">{state.ok}</p>}
    </form>
  );
}
