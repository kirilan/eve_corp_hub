import Link from "next/link";
import { OrdersTable } from "@/components/income/orders-table";
import { portraitUrl } from "@/lib/eve/names";
import { openOrders } from "@/lib/orders/check";
import { eveTime } from "./shared";

/**
 * Open market orders of every character that allows order tracking, read live, with whether each is
 * still the lowest sell or highest buy at its station.
 */
export async function OpenOrders({
  userId,
  characterIds,
  colorOf,
}: {
  userId: string;
  characterIds: number[];
  colorOf: (id: number) => string;
}) {
  const report = await openOrders(userId);
  const allowed = report.characters.filter((c) => c.allowed);
  const failing = report.characters.filter((c) => c.error);
  const oldestBook = report.orders
    .map((o) => o.bookAsOf)
    .filter((d): d is string => d !== null)
    .sort()[0];

  if (allowed.length === 0) {
    return (
      <p className="rounded border border-border bg-surface p-4 text-sm text-muted">
        None of your characters allows order tracking. On{" "}
        <Link href="/characters" className="text-accent hover:underline">
          Characters
        </Link>
        , choose <em>Allow order tracking</em> for each character whose market orders you want to follow: it asks EVE for
        read access to that character&apos;s orders. They are read when you open this page and not stored.
      </p>
    );
  }

  const withOrders = allowed.filter((c) => c.orders > 0);
  return (
    <div className="space-y-3">
      {failing.map((c) => (
        <p key={c.id} className="text-sm text-amber-400">
          {c.name}: {c.error}
        </p>
      ))}
      {report.warnings.map((warning) => (
        <p key={warning} className="text-sm text-amber-400">
          {warning}
        </p>
      ))}
      {report.orders.length === 0 ? (
        <p className="rounded border border-border bg-surface p-4 text-sm text-muted">No open orders.</p>
      ) : (
        <OrdersTable
          orders={report.orders}
          characters={withOrders.map((c) => ({ id: c.id, name: c.name, portrait: portraitUrl(c.id, 32), color: colorOf(c.id) }))}
          initialCharacters={characterIds.filter((id) => withOrders.some((c) => c.id === id))}
          now={report.checkedAt}
        />
      )}
      <p className="text-xs text-muted">
        Each order is compared with the other orders on its side of its station&apos;s book; your own orders never count
        as competition. Buy orders are compared at their station only, whatever their range. Books are at most 5 minutes
        old at stations and 15 minutes in player structures
        {oldestBook ? ` (oldest used: ${eveTime(new Date(oldestBook))})` : ""}; a structure&apos;s market needs a character of
        yours that can dock there to allow market reading. EVE refreshes a character&apos;s order list every 20 minutes.
        {allowed.length < report.characters.length && (
          <>
            {" "}
            {report.characters.length - allowed.length} of your characters do not allow order tracking (
            <Link href="/characters" className="text-accent hover:underline">
              Characters
            </Link>
            ).
          </>
        )}
      </p>
    </div>
  );
}
