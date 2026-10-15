import { redirect, unstable_rethrow } from "next/navigation";
import type { NextRequest } from "next/server";
import { completeSignIn, LinkConflictError } from "@/lib/auth/accounts";
import { currentUserId, startSession, takeSsoFlow } from "@/lib/auth/session";
import { affiliations } from "@/lib/eve/esi";
import { exchangeCode, scopesFor, verifyAccessToken } from "@/lib/eve/sso";

function back(path: string, notice: string, extra: Record<string, string> = {}): never {
  const url = new URL(path, "http://local");
  url.searchParams.set("notice", notice);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  redirect(url.pathname + url.search);
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const flow = await takeSsoFlow();
  // A missing flow is a stale tab or an expired 10-minute window; a mismatch could be CSRF. Either way, start over.
  if (!flow || flow.state !== params.get("state")) back("/", "sso-expired");
  const code = params.get("code");
  if (params.get("error") || !code) back(flow.returnTo, "sso-cancelled");

  let result;
  let name = "";
  try {
    const tokens = await exchangeCode(code, flow.verifier);
    const verified = await verifyAccessToken(tokens.access_token);
    name = verified.name;
    const missing = scopesFor(flow.features).filter((scope) => !verified.scopes.includes(scope));
    if (missing.length > 0) back(flow.returnTo, "scopes-missing", { character: name });

    const userId = await currentUserId();
    if (flow.intent === "link" && !userId) back("/", "session-expired");
    // Affiliation is nice to have at sign-in, not worth failing it: the next page view retries.
    const affiliation = await affiliations([verified.characterId])
      .then((rows) => rows[0] ?? null)
      .catch(() => null);
    result = await completeSignIn({ intent: flow.intent, currentUserId: userId, verified, tokens, affiliation });
  } catch (error) {
    // back() redirects by throwing; those must pass through untouched.
    unstable_rethrow(error);
    if (error instanceof LinkConflictError) back(flow.returnTo, "link-conflict", { character: error.characterName });
    console.error("SSO callback failed", error);
    back(flow.returnTo, "sso-failed");
  }

  if (result.outcome === "created" || result.outcome === "signed-in") await startSession(result.userId);
  back(flow.returnTo, result.outcome, { character: name });
}
