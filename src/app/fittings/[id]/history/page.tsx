import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { restoreFit } from "@/app/fittings/actions";
import { CopyButton } from "@/components/fittings/copy-button";
import { getViewer } from "@/lib/auth/viewer";
import { typeNames } from "@/lib/eve/types";
import { diffItems, toEft, type ItemChange } from "@/lib/fittings/eft";
import { fittingHistory } from "@/lib/fittings/store";
import { canEditFitting } from "@/lib/permissions";

export const metadata: Metadata = { title: "Fit history" };

const SOURCE: Record<string, string> = {
  created: "created",
  edited: "edited",
  imported: "imported from game",
  copied: "copied",
  restored: "restored",
};
const PLACE: Record<string, string> = {
  hi: "high",
  med: "mid",
  lo: "low",
  rig: "rig",
  subsystem: "subsystem",
  service: "service",
  DroneBay: "drones",
  FighterBay: "fighters",
  Cargo: "cargo",
};

export default function HistoryPage({ params, searchParams }: PageProps<"/fittings/[id]/history">) {
  return (
    <Suspense fallback={<p className="text-muted">Loading history…</p>}>
      <History params={params} searchParams={searchParams} />
    </Suspense>
  );
}

async function History({
  params,
  searchParams,
}: {
  params: PageProps<"/fittings/[id]/history">["params"];
  searchParams: PageProps<"/fittings/[id]/history">["searchParams"];
}) {
  const { id } = await params;
  const { restored, as } = await searchParams;
  const viewer = await getViewer();
  const history = await fittingHistory(viewer, id);
  if (!history) notFound();
  const { fit, versions } = history;
  const canRestore = canEditFitting(viewer, fit);
  const names = await typeNames(versions.flatMap((v) => [v.shipTypeId, ...v.items.map((item) => item.type_id)]));
  const name = (typeId: number) => names.get(typeId) ?? `Type ${typeId}`;
  const changeList = (changes: ItemChange[], sign: string) =>
    changes.map((c) => `${sign}${c.quantity > 1 ? `${c.quantity}× ` : ""}${name(c.typeId)} (${PLACE[c.where] ?? c.where})`);

  return (
    <div className="space-y-6">
      <div>
        <Link href={`/fittings/${fit.id}`} className="text-sm text-accent hover:underline">
          ← {fit.name}
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">History</h1>
        <p className="text-sm text-muted">
          Every saved state of this fit&apos;s contents. Restoring adds a new version; nothing is ever overwritten.
        </p>
      </div>
      {typeof restored === "string" && (
        <p role="status" className="rounded border border-emerald-700/60 bg-emerald-950/40 px-4 py-3 text-sm">
          Restored version {restored} as version {typeof as === "string" ? as : "?"}.
        </p>
      )}
      <ol className="space-y-3">
        {versions.map((version, index) => {
          const previous = versions[index + 1];
          const diff = previous ? diffItems(previous.items, version.items) : null;
          const lines = diff ? [...changeList(diff.added, "+ "), ...changeList(diff.removed, "− ")] : [];
          const renamed = previous && previous.name !== version.name;
          const hullChanged = previous && previous.shipTypeId !== version.shipTypeId;
          const isCurrent = index === 0;
          const eft = toEft(version, names);
          return (
            <li key={version.id} className="rounded border border-border bg-surface p-4">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-medium">Version {version.version}</span>
                {isCurrent && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-xs text-accent">current</span>}
                <span className="text-sm text-muted">
                  {SOURCE[version.source] ?? version.source} by {version.editorName ?? "someone no longer here"} ·{" "}
                  {version.createdAt.toISOString().slice(0, 16).replace("T", " ")} UTC
                </span>
              </div>
              {previous && (
                <ul className="mt-2 space-y-0.5 font-mono text-xs">
                  {hullChanged && <li>hull: {name(previous.shipTypeId)} → {name(version.shipTypeId)}</li>}
                  {renamed && <li>name: {previous.name} → {version.name}</li>}
                  {previous.description !== version.description && <li>description changed</li>}
                  {lines.map((line) => (
                    <li key={line} className={line.startsWith("+") ? "text-emerald-300" : "text-red-300"}>
                      {line}
                    </li>
                  ))}
                  {!hullChanged && !renamed && lines.length === 0 && previous.description === version.description && (
                    <li className="text-muted">same contents (module order only)</li>
                  )}
                </ul>
              )}
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <details className="w-full">
                  <summary className="cursor-pointer text-sm text-muted hover:text-foreground">EFT of this version</summary>
                  <div className="mt-2 space-y-2">
                    <CopyButton text={eft} label="Copy EFT" />
                    <pre className="max-h-60 overflow-auto rounded border border-border bg-background p-3 font-mono text-xs">{eft}</pre>
                  </div>
                </details>
                {canRestore && !isCurrent && (
                  <form action={restoreFit.bind(null, fit.id, version.version)}>
                    <button className="rounded border border-border px-3 py-1.5 text-sm hover:border-accent">Restore this version</button>
                  </form>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
