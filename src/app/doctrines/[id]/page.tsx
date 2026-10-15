import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { DoctrineForm } from "@/components/doctrine-form";
import { FitCollection } from "@/components/fittings/fit-collection";
import { getViewer } from "@/lib/auth/viewer";
import { doctrineWithFits } from "@/lib/doctrines";
import { canManageDoctrines } from "@/lib/permissions";
import { dropDoctrine, editDoctrine, removeFromDoctrine } from "../actions";

export default function DoctrinePage({ params }: PageProps<"/doctrines/[id]">) {
  return (
    <Suspense fallback={<p className="text-muted">Loading doctrine…</p>}>
      <Doctrine params={params} />
    </Suspense>
  );
}

async function Doctrine({ params }: { params: PageProps<"/doctrines/[id]">["params"] }) {
  const { id } = await params;
  const viewer = await getViewer();
  const result = await doctrineWithFits(viewer, id);
  if (!result) notFound();
  const { doctrine, fits, hidden } = result;
  const manager = canManageDoctrines(viewer, doctrine.corporationId);

  return (
    <div className="space-y-6">
      <div>
        <Link href="/doctrines" className="text-sm text-accent hover:underline">
          ← Doctrines
        </Link>
        <h1 className="mt-1 text-2xl font-semibold">{doctrine.name}</h1>
        {doctrine.description && <p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm text-muted">{doctrine.description}</p>}
      </div>

      <FitCollection
        fits={fits}
        viewer={viewer}
        showOwner
        empty={
          manager
            ? "No fits yet. Open a fit shared with the corporation (or a public one) and use “Add to doctrine”."
            : "No fits in this doctrine yet."
        }
      />
      {hidden > 0 && (
        <p className="text-sm text-amber-300">
          {hidden} fit{hidden === 1 ? " is" : "s are"} no longer shared with the corporation and hidden here.
        </p>
      )}

      {manager && (
        <section className="space-y-4 rounded border border-border bg-surface p-4">
          <h2 className="font-medium">Manage doctrine</h2>
          <DoctrineForm
            action={editDoctrine.bind(null, doctrine.id)}
            initial={{ name: doctrine.name, description: doctrine.description }}
            submit="Save changes"
          />
          {fits.length > 0 && (
            <ul className="space-y-1 text-sm">
              {fits.map((fit) => (
                <li key={fit.id} className="flex items-center gap-2">
                  <form action={removeFromDoctrine.bind(null, doctrine.id, fit.id)}>
                    <button className="rounded border border-border px-2 py-0.5 text-xs text-red-300 hover:border-red-400">Remove</button>
                  </form>
                  <span>
                    {fit.name} <span className="text-muted">· {fit.shipName}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <details>
            <summary className="cursor-pointer text-sm text-red-300">Delete doctrine…</summary>
            <form action={dropDoctrine.bind(null, doctrine.id)} className="mt-2">
              <button className="rounded bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-600">
                Yes, delete “{doctrine.name}” (its fits stay)
              </button>
            </form>
          </details>
        </section>
      )}
    </div>
  );
}
