import "server-only";
import { and, arrayContains, asc, eq, lt, or, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { characters, walletEntries, walletSyncs } from "@/db/schema";
import { characterAccessToken, ConsentMissingError } from "@/lib/auth/tokens";
import { esiPages } from "@/lib/eve/esi";
import { FEATURE_SCOPES } from "@/lib/eve/sso";
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
 * Reads one character's wallet journal and stores its new income and charge lines. Never throws: a failure
 * is recorded on the character's sync row and shown next to its data, which stays as it was.
 */
export async function syncCharacterIncome(userId: string, characterId: number): Promise<void> {
  const now = new Date();
  try {
    const token = await characterAccessToken(userId, characterId, "wallet");
    const journal = await esiPages<JournalEntry>(`/characters/${characterId}/wallet/journal`, { token });
    const rows = walletRows(characterId, journal);
    await db.transaction(async (tx) => {
      for (let i = 0; i < rows.length; i += 1000) {
        await tx.insert(walletEntries).values(rows.slice(i, i + 1000)).onConflictDoNothing();
      }
      const historyFrom = new Date(now.getTime() - JOURNAL_DAYS * 24 * 60 * 60 * 1000);
      await tx
        .insert(walletSyncs)
        .values({ characterId, historyFrom, syncedAt: now, attemptedAt: now, error: null })
        .onConflictDoUpdate({
          target: walletSyncs.characterId,
          // History start is set once; a resync after it was deleted starts it again.
          set: { historyFrom: sql`coalesce(${walletSyncs.historyFrom}, ${historyFrom})`, syncedAt: now, attemptedAt: now, error: null },
        });
    });
  } catch (error) {
    const message =
      error instanceof ConsentMissingError
        ? "Wallet access was revoked in EVE; grant it again to keep tracking"
        : error instanceof Error
          ? error.message
          : String(error);
    if (!(error instanceof ConsentMissingError)) console.warn(`wallet sync failed for character ${characterId}`, error);
    // The character may be gone by now (transferred to another account): nothing left to record against.
    await db
      .insert(walletSyncs)
      .values({ characterId, attemptedAt: now, error: message })
      .onConflictDoUpdate({ target: walletSyncs.characterId, set: { attemptedAt: now, error: message } })
      .catch(() => undefined);
  }
}

const tracking = arrayContains(characters.scopes, [...FEATURE_SCOPES.wallet]);

function due(before: Date) {
  return or(isNull(walletSyncs.attemptedAt), lt(walletSyncs.attemptedAt, before));
}

/** Syncs a profile's tracked characters not synced within the hour; called when the owner opens the tracker. */
export async function syncStaleIncome(userId: string): Promise<void> {
  const stale = await db
    .select({ id: characters.id })
    .from(characters)
    .leftJoin(walletSyncs, eq(walletSyncs.characterId, characters.id))
    .where(and(eq(characters.userId, userId), tracking, due(new Date(Date.now() - SYNC_INTERVAL_MS))));
  await Promise.all(stale.map((character) => syncCharacterIncome(userId, character.id)));
}

/**
 * Syncs every tracked character across all profiles, least recently attempted first, until the
 * time budget runs out. Run daily by cron so history has no gaps even for owners who rarely look:
 * the journal only reaches 30 days back.
 */
export async function syncAllIncome(budgetMs: number, concurrency = 4): Promise<{ synced: number; remaining: number }> {
  const deadline = Date.now() + budgetMs;
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
      await syncCharacterIncome(character.userId, character.id);
      synced++;
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { synced, remaining: queue.length - synced };
}

/** Forgets a character's stored income history. If it still allows wallet tracking, the next sync starts over from 30 days back. */
export async function deleteIncomeHistory(userId: string, characterId: number): Promise<void> {
  const [own] = await db
    .select({ id: characters.id })
    .from(characters)
    .where(and(eq(characters.id, characterId), eq(characters.userId, userId)));
  if (!own) throw new Error("that character is not linked to your profile");
  await db.transaction(async (tx) => {
    await tx.delete(walletEntries).where(eq(walletEntries.characterId, characterId));
    await tx.delete(walletSyncs).where(eq(walletSyncs.characterId, characterId));
  });
}
