import "server-only";
import { and, eq, inArray, ne } from "drizzle-orm";
import { db } from "@/db";
import { characters, type SharedOrder, sharedOrders } from "@/db/schema";
import { refreshCharacterAffiliations } from "@/lib/auth/accounts";
import { characterAccessToken, ConsentMissingError } from "@/lib/auth/tokens";
import { esi } from "@/lib/eve/esi";
import { hasFeature } from "@/lib/eve/sso";
import { type OrderSharer, sharesOrdersWith } from "@/lib/permissions";
import type { EsiCharacterOrder } from "./check";

/**
 * Orders shared between corp members, so each can see when a corp member is the one ahead of them.
 * Only characters that opted in (Characters → Share orders with corp) are kept or matched, and only
 * against others that opted in too; see `sharesOrdersWith`.
 */

// EVE refreshes a character's order list every 20 minutes: reading it sooner returns the same list.
export const SHARED_MAX_AGE_MS = 20 * 60 * 1000;
// Corp members' snapshots refreshed in one page view at most; the rest wait for the next view.
const MAX_REFRESHES = 25;
const REFRESH_CONCURRENCY = 5;

export function toShared(orders: EsiCharacterOrder[]): SharedOrder[] {
  return orders.map((o) => ({
    locationId: o.location_id,
    typeId: o.type_id,
    isBuy: Boolean(o.is_buy_order),
    price: o.price,
    remain: o.volume_remain,
  }));
}

/** Replaces a sharing character's kept orders with what was just read. */
export async function saveSharedOrders(characterId: number, orders: SharedOrder[]): Promise<void> {
  const fetchedAt = new Date();
  await db
    .insert(sharedOrders)
    .values({ characterId, orders, fetchedAt })
    .onConflictDoUpdate({ target: sharedOrders.characterId, set: { orders, fetchedAt } });
}

export type CorpOrder = SharedOrder & { corporationId: number };

/**
 * Open orders of other profiles' characters that share with one of `mine`, read from their
 * snapshots; a snapshot older than EVE's refresh is read again first, with that character's token.
 */
export async function corpOrders(userId: string, mine: (OrderSharer & { id: number })[], signal: AbortSignal): Promise<CorpOrder[]> {
  const corporations = [...new Set(mine.filter((c) => c.shareOrdersWithCorp && c.ordersAllowed && c.corporationId !== null).map((c) => c.corporationId!))];
  if (corporations.length === 0) return [];
  const candidates = async () =>
    db
      .select({
        id: characters.id,
        userId: characters.userId,
        corporationId: characters.corporationId,
        scopes: characters.scopes,
        shareOrdersWithCorp: characters.shareOrdersWithCorp,
      })
      .from(characters)
      .where(and(inArray(characters.corporationId, corporations), eq(characters.shareOrdersWithCorp, true), ne(characters.userId, userId)));
  // Someone who left the corporation and has not signed in since still has the old one stored.
  await refreshCharacterAffiliations((await candidates()).map((c) => c.id));
  const theirs = (await candidates())
    .map((c) => ({ ...c, ordersAllowed: hasFeature(c.scopes, "orders") }))
    .filter((c) => mine.some((m) => sharesOrdersWith(m, c)));
  if (theirs.length === 0) return [];

  const kept = new Map(
    (await db.select().from(sharedOrders).where(inArray(sharedOrders.characterId, theirs.map((c) => c.id)))).map((row) => [row.characterId, row]),
  );
  const cutoff = Date.now() - SHARED_MAX_AGE_MS;
  const stale = theirs
    .filter((c) => (kept.get(c.id)?.fetchedAt.getTime() ?? 0) < cutoff)
    .sort((a, b) => (kept.get(a.id)?.fetchedAt.getTime() ?? 0) - (kept.get(b.id)?.fetchedAt.getTime() ?? 0))
    .slice(0, MAX_REFRESHES);
  for (let i = 0; i < stale.length; i += REFRESH_CONCURRENCY) {
    await Promise.all(
      stale.slice(i, i + REFRESH_CONCURRENCY).map(async (c) => {
        if (signal.aborted) return;
        try {
          // The owner's own consent (order tracking plus sharing) is what allows this read; the id comes from the database.
          const token = await characterAccessToken(c.userId, c.id, "orders", signal);
          const orders = await esi<EsiCharacterOrder[]>(`/characters/${c.id}/orders`, { token, signal });
          if (!Array.isArray(orders)) throw new Error("orders are not a list");
          const shared = toShared(orders);
          await saveSharedOrders(c.id, shared);
          kept.set(c.id, { characterId: c.id, orders: shared, fetchedAt: new Date() });
        } catch (error) {
          if (error instanceof ConsentMissingError) {
            await db.delete(sharedOrders).where(eq(sharedOrders.characterId, c.id));
            kept.delete(c.id);
          } else {
            // The older snapshot stays in use; the live book still has to show each order's price.
            console.warn(`shared order read failed for character ${c.id}`, error);
          }
        }
      }),
    );
  }
  return theirs.flatMap((c) => (kept.get(c.id)?.orders ?? []).map((o) => ({ ...o, corporationId: c.corporationId! })));
}
