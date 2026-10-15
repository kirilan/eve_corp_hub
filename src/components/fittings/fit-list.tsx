import Image from "next/image";
import Link from "next/link";
import { typeIconUrl } from "@/lib/eve/images";
import type { FitRow } from "@/lib/fittings/store";
import { VisibilityBadge } from "./visibility-badge";

export function FitList({ fits, showOwner = false, empty }: { fits: FitRow[]; showOwner?: boolean; empty: React.ReactNode }) {
  if (fits.length === 0) return <div className="rounded border border-dashed border-border p-6 text-sm text-muted">{empty}</div>;
  return (
    <ul className="divide-y divide-border rounded border border-border bg-surface">
      {fits.map((fit) => (
        <li key={fit.id}>
          <Link href={`/fittings/${fit.id}`} prefetch={false} className="flex items-center gap-3 px-4 py-3 hover:bg-white/5">
            <Image src={typeIconUrl(fit.shipTypeId, 64)} alt="" width={36} height={36} unoptimized className="rounded" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{fit.name}</div>
              <div className="truncate text-sm text-muted">
                {fit.shipName ?? `Type ${fit.shipTypeId}`}
                {showOwner && fit.ownerMainName && <> · by {fit.ownerMainName}</>}
              </div>
            </div>
            <VisibilityBadge visibility={fit.visibility} />
          </Link>
        </li>
      ))}
    </ul>
  );
}
