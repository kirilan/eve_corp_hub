import Link from "next/link";
import { OrdersPanel } from "@/components/income/orders-table";
import { openOrders } from "@/lib/orders/check";

/**
 * Open market orders of every character that allows order tracking, read live, with whether each is
 * still the lowest sell or highest buy at its station, and whether a corp member is the one ahead.
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

  if (!report.characters.some((c) => c.allowed)) {
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

  return (
    <OrdersPanel
      initial={report}
      colors={Object.fromEntries(report.characters.map((c) => [c.id, colorOf(c.id)]))}
      initialCharacters={characterIds}
    />
  );
}
