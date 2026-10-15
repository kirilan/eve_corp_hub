import "server-only";
import { and, eq, gt } from "drizzle-orm";
import { cookies } from "next/headers";
import { cache } from "react";
import { db } from "@/db";
import { sessions } from "@/db/schema";
import { decrypt, encrypt, randomToken, sha256 } from "@/lib/crypto";
import type { Feature } from "@/lib/eve/sso";
import type { Intent } from "./accounts";

const SESSION_COOKIE = "session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SSO_COOKIE = "sso_flow";
const SSO_TTL_S = 10 * 60;

// Lax, not Strict: the SSO callback is a cross-site top-level navigation back from
// login.eveonline.com, and linking needs the session cookie on exactly that request.
const baseCookie = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  path: "/",
};

/** Call only from a Route Handler or Server Function: setting cookies is impossible mid-render. */
export async function startSession(userId: string): Promise<void> {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: sha256(token), userId, expiresAt });
  (await cookies()).set(SESSION_COOKIE, token, { ...baseCookie, expires: expiresAt });
}

export async function endSession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) await db.delete(sessions).where(eq(sessions.id, sha256(token)));
  store.delete(SESSION_COOKIE);
}

/** The signed-in profile's id, or null. Deduplicated per request. */
export const currentUserId = cache(async (): Promise<string | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  const [row] = await db
    .select({ userId: sessions.userId })
    .from(sessions)
    .where(and(eq(sessions.id, sha256(token)), gt(sessions.expiresAt, new Date())));
  return row?.userId ?? null;
});

export type SsoFlow = {
  state: string;
  verifier: string;
  intent: Intent;
  features: Feature[];
  returnTo: string;
};

export async function saveSsoFlow(flow: SsoFlow): Promise<void> {
  // Encrypted (and so tamper-evident): the verifier must stay secret and the intent must not be swapped.
  (await cookies()).set(SSO_COOKIE, encrypt(JSON.stringify(flow)), { ...baseCookie, maxAge: SSO_TTL_S });
}

/** Reads and clears the pending SSO flow: each one is good for exactly one callback. */
export async function takeSsoFlow(): Promise<SsoFlow | null> {
  const store = await cookies();
  const sealed = store.get(SSO_COOKIE)?.value;
  store.delete(SSO_COOKIE);
  if (!sealed) return null;
  try {
    return JSON.parse(decrypt(sealed)) as SsoFlow;
  } catch {
    return null;
  }
}

/** Only same-site paths: an open redirect after login would be a phishing gift. */
export function safeReturnTo(value: string | null | undefined, fallback = "/"): string {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : fallback;
}
