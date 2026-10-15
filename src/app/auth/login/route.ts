import { redirect } from "next/navigation";
import type { NextRequest } from "next/server";
import { randomToken } from "@/lib/crypto";
import { authorizeUrl, isFeature, scopesFor } from "@/lib/eve/sso";
import { saveSsoFlow, safeReturnTo } from "@/lib/auth/session";

/**
 * Starts EVE SSO. Query: `intent=login|link`, optional `feature=fittings` (repeatable) to ask for
 * that feature's scopes, optional `returnTo` path.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const intent = params.get("intent") === "link" ? "link" : "login";
  const features = params.getAll("feature").filter(isFeature);
  const state = randomToken(16);
  const verifier = randomToken(32);
  await saveSsoFlow({
    state,
    verifier,
    intent,
    features,
    returnTo: safeReturnTo(params.get("returnTo"), intent === "link" ? "/characters" : "/"),
  });
  redirect(authorizeUrl({ state, verifier, scopes: scopesFor(features) }));
}
