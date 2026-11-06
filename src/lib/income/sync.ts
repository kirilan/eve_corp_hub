import "server-only";
import { and, arrayContains, asc, eq, lt, or, isNull, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { db } from "@/db";
import { lockOwnedCharacter } from "@/lib/auth/accounts";
import { deadlineSignal, OPERATION_TIMEOUT_MS } from "@/lib/eve/deadline";
import { characters, walletEntries, walletSyncs } from "@/db/schema";
import { characterAccessToken, ConsentMissingError } from "@/lib/auth/tokens";
import { esiPages } from "@/lib/eve/esi";
import { FEATURE_SCOPES, hasFeature } from "@/lib/eve/sso";
import { expenseOf, sourceOf } from "./sources";

// ESI caches the journal for an hour: syncing more often only re-reads the same pages.
const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const JOURNAL_DAYS = 30;

export type JournalEntry = {
  id: number;
  date: string;
  ref_type: string;
  amount?: number;
  tax?: number;
  context_id?: number;
  context_id_type?: string;
};

/** Whether the tracker keeps a journal line: ISK coming in from income, or going out on charges against it. */
function kept(entry: JournalEntry): boolean {
  const amount = entry.amount ?? 0;
  return (sourceOf(entry.ref_type) !== null && amount > 0) || (expenseOf(entry.ref_type) !== null && amount < 0);
}

/** The income and charge lines of a wallet journal, as rows to store. Everything else in the wallet is dropped here. */
export function walletRows(characterId: number, journal: JournalEntry[]): (typeof walletEntries.$inferInsert)[] {
  return journal
    .filter(kept)
    .map((entry) => ({
      characterId,
      journalId: entry.id,
      date: new Date(entry.date),
      refType: entry.ref_type,
      amount: entry.amount ?? 0,
      tax: entry.tax ?? 0,
      solarSystemId: entry.context_id_type === "system_id" ? (entry.context_id ?? null) : null,
    }));
}

/**
 * Claims one due character before fetching. The random lease also identifies this exact ownership
 * and attempt: transfer/unlink deletes it, and revoke/delete-history invalidates it. Recheck it
 * under the character lock before any writes, including error status.
 */
export async function syncCharacterIncome(userId: string, characterId: number, parentSignal?: AbortSignal): Promise<void> {
  const signal = deadlineSignal(OPERATION_TIMEOUT_MS, parentSignal);
  const now = new Date();
  const leaseId = randomUUID();
  const claim = await db.transaction(async (tx) => {
    const character = await lockOwnedCharacter(tx, userId, characterId);
    if (!character || !hasFeature(character.scopes, "wallet") || signal.aborted) return null;
    const [claimed] = await tx.insert(walletSyncs).values({
      characterId, attemptedAt: now, leaseId, leaseExpiresAt: new Date(now.getTime() + OPERATION_TIMEOUT_MS + 15_000),
    }).onConflictDoUpdate({
      target: walletSyncs.characterId,
      set: { attemptedAt: now, leaseId, leaseExpiresAt: new Date(now.getTime() + OPERATION_TIMEOUT_MS + 15_000) },
      setWhere: due(new Date(now.getTime() - SYNC_INTERVAL_MS)),
    }).returning();
    return claimed ? { ownerHash: character.ownerHash } : null;
  });
  if (!claim) return;
  const ownsLease = and(eq(walletSyncs.characterId, characterId), eq(walletSyncs.leaseId, leaseId));
  try {
    const token = await characterAccessToken(userId, characterId, "wallet", signal);
    signal.throwIfAborted();
    const journal = await esiPages<JournalEntry>(`/characters/${characterId}/wallet/journal`, { token, signal });
    const rows = walletRows(characterId, journal);
    await db.transaction(async (tx) => {
      const character = await lockOwnedCharacter(tx, userId, characterId);
      if (!character || character.ownerHash !== claim.ownerHash || !hasFeature(character.scopes, "wallet")) return;
      const [lease] = await tx.select().from(walletSyncs).where(ownsLease);
      if (!lease || !lease.leaseExpiresAt || lease.leaseExpiresAt <= new Date()) return;
      signal.throwIfAborted();
      for (let i = 0; i < rows.length; i += 1000) {
        signal.throwIfAborted();
        await tx.insert(walletEntries).values(rows.slice(i, i + 1000)).onConflictDoNothing();
      }
      const historyFrom = new Date(now.getTime() - JOURNAL_DAYS * 24 * 60 * 60 * 1000);
      await tx.update(walletSyncs).set({
        historyFrom: sql`coalesce(${walletSyncs.historyFrom}, ${historyFrom})`,
        syncedAt: now, error: null, leaseId: null, leaseExpiresAt: null,
      }).where(ownsLease);
    });
  } catch (error) {
    const message = error instanceof ConsentMissingError
      ? "Wallet access was revoked in EVE; grant it again to keep tracking"
      : error instanceof Error ? error.message : String(error);
    if (!(error instanceof ConsentMissingError)) console.warn(`wallet sync failed for character ${characterId}`, error);
    await db.transaction(async (tx) => {
      const character = await lockOwnedCharacter(tx, userId, characterId);
      if (!character || character.ownerHash !== claim.ownerHash) return;
      await tx.update(walletSyncs).set({ error: message, leaseId: null, leaseExpiresAt: null }).where(ownsLease);
    });
  }
}

const tracking = arrayContains(characters.scopes, [...FEATURE_SCOPES.wallet]);

function due(before: Date) {
  return or(
    // A killed worker is retried after its lease, rather than held off for the full hour.
    lt(walletSyncs.leaseExpiresAt, new Date()),
    and(isNull(walletSyncs.leaseId), or(isNull(walletSyncs.attemptedAt), lt(walletSyncs.attemptedAt, before))),
  );
}

/** Syncs a profile's tracked characters not synced within the hour; called when the owner opens the tracker. */
export async function syncStaleIncome(userId: string): Promise<void> {
  const stale = await db
    .select({ id: characters.id })
    .from(characters)
    .leftJoin(walletSyncs, eq(walletSyncs.characterId, characters.id))
    .where(and(eq(characters.userId, userId), tracking, due(new Date(Date.now() - SYNC_INTERVAL_MS))));
  const signal = deadlineSignal(OPERATION_TIMEOUT_MS);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, stale.length) }, async () => {
    while (next < stale.length && !signal.aborted) await syncCharacterIncome(userId, stale[next++].id, signal);
  }));
}

/**
 * Syncs every tracked character across all profiles, least recently attempted first, until the
 * time budget runs out. Run daily by cron so history has no gaps even for owners who rarely look:
 * the journal only reaches 30 days back.
 */
export async function syncAllIncome(budgetMs: number, concurrency = 4): Promise<{ synced: number; remaining: number }> {
  const deadline = Date.now() + budgetMs;
  const signal = deadlineSignal(Math.max(1, budgetMs));
  const queue = await db
    .select({ id: characters.id, userId: characters.userId })
    .from(characters)
    .leftJoin(walletSyncs, eq(walletSyncs.characterId, characters.id))
    .where(and(tracking, due(new Date(Date.now() - SYNC_INTERVAL_MS))))
    .orderBy(sql`${walletSyncs.attemptedAt} asc nulls first`, asc(characters.id));
  let next = 0;
  let synced = 0;
  async function worker() {
    while (next < queue.length && Date.now() < deadline) {
      const character = queue[next++];
      await syncCharacterIncome(character.userId, character.id, signal);
      synced++;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { synced, remaining: queue.length - synced };
}

/** Forgets a character's stored income history. If it still allows wallet tracking, the next sync starts over from 30 days back. */
export async function deleteIncomeHistory(userId: string, characterId: number): Promise<void> {
  await db.transaction(async (tx) => {
    if (!await lockOwnedCharacter(tx, userId, characterId)) throw new Error("that character is not linked to your profile");
    await tx.delete(walletEntries).where(eq(walletEntries.characterId, characterId));
    await tx.delete(walletSyncs).where(eq(walletSyncs.characterId, characterId));
  });
}
