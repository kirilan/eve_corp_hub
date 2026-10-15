import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { DoctrineForm } from "@/components/doctrine-form";
import { SignInButton } from "@/components/sign-in-button";
import { getViewer } from "@/lib/auth/viewer";
import { listDoctrines } from "@/lib/doctrines";
import { entityNames } from "@/lib/eve/names";
import { canManageDoctrines } from "@/lib/permissions";
import { newDoctrine } from "./actions";

export const metadata: Metadata = { title: "Doctrines" };

export default function DoctrinesPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Doctrines</h1>
        <p className="mt-1 text-sm text-muted">
          Sets of fits your corporation flies together. Open one to send all of its fits to a character at once.
        </p>
      </div>
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <Doctrines />
      </Suspense>
    </div>
  );
}

async function Doctrines() {
  const viewer = await getViewer();
  if (!viewer) return <SignInButton returnTo="/doctrines" />;
  const corporationId = viewer.main?.corporationId ?? null;
  if (corporationId === null) return <p className="text-sm text-muted">Your main character has no known corporation.</p>;
  const [doctrines, names] = await Promise.all([listDoctrines(viewer), entityNames([corporationId])]);
  const manager = canManageDoctrines(viewer);

  return (
    <div className="space-y-6">
      <h2 className="text-sm text-muted">{names[corporationId] ?? "Your corporation"}</h2>
      {doctrines.length === 0 ? (
        <p className="rounded border border-dashed border-border p-6 text-sm text-muted">
          No doctrines yet.{manager ? " Create the first one below." : " Your corporation's directors and super users can create them."}
        </p>
      ) : (
        <ul className="divide-y divide-border rounded border border-border bg-surface">
          {doctrines.map((doctrine) => (
            <li key={doctrine.id}>
              <Link href={`/doctrines/${doctrine.id}`} className="flex items-baseline gap-3 px-4 py-3 hover:bg-white/5">
                <span className="font-medium">{doctrine.name}</span>
                <span className="text-sm text-muted">
                  {doctrine.fits} fit{doctrine.fits === 1 ? "" : "s"}
                </span>
                {doctrine.description && <span className="truncate text-sm text-muted">· {doctrine.description}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
      {manager && (
        <section className="space-y-3 rounded border border-border bg-surface p-4">
          <h2 className="font-medium">New doctrine</h2>
          <DoctrineForm action={newDoctrine} submit="Create doctrine" />
        </section>
      )}
    </div>
  );
}
