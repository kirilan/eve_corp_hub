type Params = { character: string; count: string };

const MESSAGES: Record<string, (p: Params) => { text: string; tone: "ok" | "warn" }> = {
  "fit-saved": () => ({ text: "Fit saved.", tone: "ok" }),
  "fit-copied": () => ({ text: "Saved a private copy to your fittings.", tone: "ok" }),
  "fit-deleted": () => ({ text: "Fit deleted.", tone: "ok" }),
  "fits-imported": ({ count }) => ({
    text: count === "0" ? "Nothing new to import." : `Imported ${count} fit${count === "1" ? "" : "s"} from the game.`,
    tone: "ok",
  }),
  created: ({ character: c }) => ({ text: `Welcome! Your profile was created with ${c || "this character"} as main.`, tone: "ok" }),
  "signed-in": ({ character: c }) => ({ text: `Signed in as ${c || "your character"}.`, tone: "ok" }),
  linked: ({ character: c }) => ({ text: `${c || "Character"} is now linked to your profile.`, tone: "ok" }),
  updated: ({ character: c }) => ({ text: `Updated access for ${c || "this character"}.`, tone: "ok" }),
  "link-conflict": ({ character: c }) => ({
    text: `${c || "That character"} already belongs to another profile. Sign in to that profile and unlink it there first.`,
    tone: "warn",
  }),
  "scopes-missing": ({ character: c }) => ({ text: `${c || "The character"} did not grant the requested access.`, tone: "warn" }),
  "sso-cancelled": () => ({ text: "EVE login was cancelled.", tone: "warn" }),
  "sso-expired": () => ({ text: "That login attempt expired. Please try again.", tone: "warn" }),
  "session-expired": () => ({ text: "Your session expired. Sign in again, then add the character.", tone: "warn" }),
  "sso-failed": () => ({ text: "EVE login failed. Please try again in a moment.", tone: "warn" }),
};

/** Shows the outcome of an SSO round trip, passed back as ?notice=…&character=…. */
export async function Notice({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const one = (value: string | string[] | undefined) => (typeof value === "string" ? value : "");
  const key = one(params.notice);
  const message = key ? MESSAGES[key] : undefined;
  // Non-fatal notes from saving a fit (e.g. dropped loaded charges).
  const warnings = ([] as string[]).concat(params.warn ?? []).slice(0, 10);
  if (!message && warnings.length === 0) return null;
  const { text, tone } = message ? message({ character: one(params.character), count: one(params.count) }) : { text: "", tone: "warn" };
  return (
    <div
      role="status"
      className={`mb-6 space-y-1 rounded border px-4 py-3 text-sm ${
        tone === "ok" ? "border-emerald-700/60 bg-emerald-950/40" : "border-amber-700/60 bg-amber-950/40"
      }`}
    >
      {text && <p>{text}</p>}
      {warnings.length > 0 && (
        <ul className="list-disc pl-5 text-amber-200">
          {warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
