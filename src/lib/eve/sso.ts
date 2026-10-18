import "server-only";
import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { env } from "@/lib/env";

// From https://login.eveonline.com/.well-known/oauth-authorization-server (checked 2026-10-15).
const ISSUER = "https://login.eveonline.com";
const AUTHORIZE_URL = "https://login.eveonline.com/v2/oauth/authorize";
const TOKEN_URL = "https://login.eveonline.com/v2/oauth/token";
const REVOKE_URL = "https://login.eveonline.com/v2/oauth/revoke";
const jwks = createRemoteJWKSet(new URL("https://login.eveonline.com/oauth/jwks"));

/**
 * Extra consent is opt-in per character, as in eve-skills: signing in asks for no scopes at all,
 * and a feature's scopes are requested only when its owner turns that feature on for a character.
 */
export const FEATURE_SCOPES = {
  fittings: ["esi-fittings.read_fittings.v1", "esi-fittings.write_fittings.v1"],
  // Ratting income tracker: reads the wallet journal, keeps only bounty and ESS payouts.
  wallet: ["esi-wallet.read_character_wallet.v1"],
} as const satisfies Record<string, readonly string[]>;

export type Feature = keyof typeof FEATURE_SCOPES;

export const FEATURES = Object.keys(FEATURE_SCOPES) as Feature[];

export function isFeature(value: unknown): value is Feature {
  return typeof value === "string" && Object.hasOwn(FEATURE_SCOPES, value);
}

export function scopesFor(features: readonly Feature[]): string[] {
  return [...new Set(features.flatMap((feature) => FEATURE_SCOPES[feature]))];
}

export function hasFeature(scopes: readonly string[], feature: Feature): boolean {
  return FEATURE_SCOPES[feature].every((scope) => scopes.includes(scope));
}

/**
 * The features to ask for when a character turns one more on. A character keeps a single refresh
 * token and each SSO grant replaces it, so the request must repeat everything already granted or
 * the new token would silently drop it.
 */
export function featuresWith(scopes: readonly string[], feature: Feature): Feature[] {
  return FEATURES.filter((f) => f === feature || hasFeature(scopes, f));
}

export function redirectUri(): string {
  return `${env().APP_URL}/auth/callback`;
}

export function codeChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function authorizeUrl(params: { state: string; verifier: string; scopes: readonly string[] }): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    response_type: "code",
    redirect_uri: redirectUri(),
    client_id: env().EVE_CLIENT_ID,
    scope: params.scopes.join(" "),
    state: params.state,
    code_challenge: codeChallenge(params.verifier),
    code_challenge_method: "S256",
  }).toString();
  return url.toString();
}

export type TokenResponse = { access_token: string; refresh_token?: string; expires_in: number };

export class SsoError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
  /** The grant itself is dead (revoked, expired, app removed): retrying will not help. */
  get invalidGrant() {
    return this.code === "invalid_grant";
  }
}

async function postForm(url: string, fields: Record<string, string>): Promise<Response> {
  const { EVE_CLIENT_ID, EVE_CLIENT_SECRET } = env();
  return fetch(url, {
    method: "POST",
    headers: {
      // Confidential client: credentials go in the Basic header only; CCP rejects them duplicated in the body.
      Authorization: `Basic ${Buffer.from(`${EVE_CLIENT_ID}:${EVE_CLIENT_SECRET}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams(fields),
    cache: "no-store",
  });
}

async function tokenRequest(fields: Record<string, string>): Promise<TokenResponse> {
  const response = await postForm(TOKEN_URL, fields);
  const body = (await response.json().catch(() => ({}))) as Partial<TokenResponse> & {
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token) {
    throw new SsoError(
      `EVE SSO token request failed (${response.status}): ${body.error_description ?? body.error ?? "no detail"}`,
      response.status,
      body.error,
    );
  }
  return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: Number(body.expires_in ?? 1199) };
}

export function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
  return tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri(), code_verifier: verifier });
}

export function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  return tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });
}

/** Best effort: a revoke that fails leaves a token that is useless to anyone without our client secret. */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  await postForm(REVOKE_URL, { token_type_hint: "refresh_token", token: refreshToken }).catch(() => undefined);
}

export type VerifiedCharacter = {
  characterId: number;
  name: string;
  ownerHash: string;
  scopes: string[];
  expiresAt: Date;
};

export async function verifyAccessToken(accessToken: string): Promise<VerifiedCharacter> {
  const { payload } = await jwtVerify(accessToken, jwks, {
    // CCP has issued both spellings over the years.
    issuer: [ISSUER, "login.eveonline.com"],
    audience: env().EVE_CLIENT_ID,
  });
  const match = /^CHARACTER:EVE:(\d+)$/.exec(String(payload.sub ?? ""));
  if (!match) throw new Error(`unexpected token subject: ${String(payload.sub)}`);
  const scp = payload.scp;
  return {
    characterId: Number(match[1]),
    name: String(payload.name ?? ""),
    ownerHash: String(payload.owner ?? ""),
    scopes: Array.isArray(scp) ? scp.map(String) : scp ? [String(scp)] : [],
    expiresAt: new Date((payload.exp ?? 0) * 1000),
  };
}
