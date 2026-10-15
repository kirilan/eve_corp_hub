const MESSAGES: Record<string, (character: string) => { text: string; tone: "ok" | "warn" }> = {
  created: (c) => ({ text: `Welcome! Your profile was created with ${c || "this character"} as main.`, tone: "ok" }),
  "signed-in": (c) => ({ text: `Signed in as ${c || "your character"}.`, tone: "ok" }),
  linked: (c) => ({ text: `${c || "Character"} is now linked to your profile.`, tone: "ok" }),
  updated: (c) => ({ text: `Updated access for ${c || "this character"}.`, tone: "ok" }),
  "link-conflict": (c) => ({
    text: `${c || "That character"} already belongs to another profile. Sign in to that profile and unlink it there first.`,
    tone: "warn",
  }),
  "scopes-missing": (c) => ({ text: `${c || "The character"} did not grant the requested access.`, tone: "warn" }),
  "sso-cancelled": () => ({ text: "EVE login was cancelled.", tone: "warn" }),
  "sso-expired": () => ({ text: "That login attempt expired. Please try again.", tone: "warn" }),
  "session-expired": () => ({ text: "Your session expired. Sign in again, then add the character.", tone: "warn" }),
  "sso-failed": () => ({ text: "EVE login failed. Please try again in a moment.", tone: "warn" }),
};

/** Shows the outcome of an SSO round trip, passed back as ?notice=…&character=…. */
export async function Notice({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const key = typeof params.notice === "string" ? params.notice : undefined;
  const message = key ? MESSAGES[key] : undefined;
  if (!message) return null;
  const { text, tone } = message(typeof params.character === "string" ? params.character : "");
  return (
    <p
      role="status"
      className={`mb-6 rounded border px-4 py-3 text-sm ${
        tone === "ok" ? "border-emerald-700/60 bg-emerald-950/40" : "border-amber-700/60 bg-amber-950/40"
      }`}
    >
      {text}
    </p>
  );
}
