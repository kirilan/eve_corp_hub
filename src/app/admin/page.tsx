import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import type { AuditEntry } from "@/db/schema";
import { AUDIT_PAGE_SIZE, readAudit } from "@/lib/audit";
import { listProfiles } from "@/lib/auth/super-users";
import { getViewer } from "@/lib/auth/viewer";
import { entityNames } from "@/lib/eve/names";
import { canAdminister, canGrantDirector, canGrantSuperUser, runsCorporation } from "@/lib/permissions";
import { toggleDirector, toggleSuperUser } from "./actions";

// No title or heading in the static shell: to anyone but a super user this page is an ordinary 404.
export const metadata: Metadata = {};

export default function AdminPage({ searchParams }: PageProps<"/admin">) {
  return (
    <div className="space-y-8">
      <Suspense fallback={<p className="text-muted">Loading…</p>}>
        <Admin searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

const VERB: Record<string, string> = {
  "fit.created": "created fit",
  "fit.edited": "edited fit",
  "fit.restored": "restored fit",
  "fit.shared": "changed sharing of fit",
  "fit.deleted": "deleted fit",
  "doctrine.created": "created doctrine",
  "doctrine.edited": "edited doctrine",
  "doctrine.deleted": "deleted doctrine",
  "doctrine.fit_added": "added a fit to doctrine",
  "doctrine.fit_removed": "removed a fit from doctrine",
  "user.super_granted": "made a super user:",
  "user.super_revoked": "removed super user from",
  "user.director_granted": "made a Corp Director:",
  "user.director_revoked": "removed Corp Director from",
};

function subjectLink(entry: AuditEntry) {
  if (entry.action.endsWith(".deleted") || entry.subjectType === "user") return entry.subjectName;
  const href = entry.subjectType === "fitting" ? `/fittings/${entry.subjectId}` : `/doctrines/${entry.subjectId}`;
  return (
    <Link href={href} prefetch={false} className="text-accent hover:underline">
      {entry.subjectName}
    </Link>
  );
}

function detail(entry: AuditEntry): string | null {
  const d = entry.details as Record<string, unknown>;
  if (entry.action === "fit.shared") return `${d.from} → ${d.to}`;
  if (entry.action === "fit.edited") return `version ${d.version}`;
  if (entry.action === "fit.restored") return `version ${d.restoredFrom} restored as ${d.version}`;
  if (entry.action === "fit.deleted" && d.moderated) return "moderation";
  if (entry.action === "fit.created" && d.visibility) return String(d.visibility);
  if (entry.action.startsWith("doctrine.fit_") && d.fit) return String(d.fit);
  if (entry.action === "doctrine.edited" && d.renamedFrom) return `renamed from ${d.renamedFrom}`;
  return null;
}

async function Admin({ searchParams }: { searchParams: PageProps<"/admin">["searchParams"] }) {
  const viewer = await getViewer();
  if (!viewer || !canAdminister(viewer)) notFound();
  const { before } = await searchParams;
  const beforeId = typeof before === "string" && /^\d+$/.test(before) ? Number(before) : undefined;
  const [profiles, entries] = await Promise.all([listProfiles(viewer), readAudit(viewer, { before: beforeId })]);
  const corpNames = await entityNames(profiles.flatMap((p) => [p.corporationId ?? 0, ...p.directorOf]));
  const corpName = (id: number) => corpNames[id] ?? `Corporation ${id}`;

  return (
    <>
      <h1 className="text-2xl font-semibold">Admin</h1>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Profiles</h2>
        <p className="text-sm text-muted">
          {viewer.isSuperUser
            ? "You are a super user: every profile is listed. "
            : `You are a Corp Director: profiles whose main is in ${viewer.main?.corporationId ? corpName(viewer.main.corporationId) : "your corporation"} are listed. `}
          Super users and Corp Directors manage their corporation&apos;s doctrines and take down fits shared with it; super
          users also moderate every public fit, directors only public fits of their own members. A director role counts only
          while that profile&apos;s main is in the role&apos;s corporation. Every change is in the audit log below.
        </p>
        <ul className="divide-y divide-border rounded border border-border bg-surface text-sm">
          {profiles.map((profile) => {
            const isDirectorHere = profile.corporationId !== null && profile.directorOf.includes(profile.corporationId);
            return (
              <li key={profile.userId} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                <span className="font-medium">{profile.mainName ?? "No main character"}</span>
                <span className="text-muted">{profile.corporationId ? corpName(profile.corporationId) : ""}</span>
                {profile.isSuperUser && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-xs text-accent">Super user</span>}
                {profile.directorOf.map((corporationId) => (
                  <span
                    key={corporationId}
                    title={corporationId === profile.corporationId ? undefined : "Suspended: this profile's main is in another corporation"}
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      corporationId === profile.corporationId ? "bg-sky-500/15 text-sky-300" : "bg-white/5 text-muted line-through"
                    }`}
                  >
                    Director · {corpName(corporationId)}
                  </span>
                ))}
                <div className="ml-auto flex flex-wrap gap-2">
                  {profile.corporationId !== null &&
                    !isDirectorHere &&
                    canGrantDirector(viewer, { userId: profile.userId, corporationId: profile.corporationId }) && (
                      <form action={toggleDirector.bind(null, profile.userId, profile.corporationId, true)}>
                        <button className="rounded border border-border px-3 py-1 hover:border-accent">Make director</button>
                      </form>
                    )}
                  {profile.userId !== viewer.userId &&
                    profile.directorOf
                      .filter((corporationId) => viewer.isSuperUser || runsCorporation(viewer, corporationId))
                      .map((corporationId) => (
                        <form key={corporationId} action={toggleDirector.bind(null, profile.userId, corporationId, false)}>
                          <button className="rounded border border-border px-3 py-1 hover:border-red-400">
                            Revoke director{profile.directorOf.length > 1 ? ` (${corpName(corporationId)})` : ""}
                          </button>
                        </form>
                      ))}
                  {canGrantSuperUser(viewer, profile.userId) && (
                    <form action={toggleSuperUser.bind(null, profile.userId, !profile.isSuperUser)}>
                      <button className="rounded border border-border px-3 py-1 hover:border-accent">
                        {profile.isSuperUser ? "Revoke super user" : "Make super user"}
                      </button>
                    </form>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Audit log</h2>
        <p className="text-sm text-muted">
          Changes to shared fits, doctrines and roles in your corporation
          {viewer.isSuperUser ? ", plus site-wide ones (public fits, super users)" : ""}. Private fits are not logged.
        </p>
        {entries.length === 0 ? (
          <p className="text-sm text-muted">Nothing recorded{beforeId ? " before this point" : " yet"}.</p>
        ) : (
          <ol className="divide-y divide-border rounded border border-border bg-surface text-sm">
            {entries.map((entry) => {
              const extra = detail(entry);
              return (
                <li key={entry.id} className="flex flex-wrap gap-x-2 px-4 py-2">
                  <span className="font-mono text-xs text-muted">{entry.at.toISOString().slice(0, 16).replace("T", " ")}</span>
                  <span>
                    <strong>{entry.actorName ?? "Unknown"}</strong> {VERB[entry.action] ?? entry.action} {subjectLink(entry)}
                    {extra && <span className="text-muted"> ({extra})</span>}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
        <div className="flex gap-3 text-sm">
          {beforeId && (
            <Link href="/admin" className="text-accent hover:underline">
              Newest
            </Link>
          )}
          {entries.length === AUDIT_PAGE_SIZE && (
            <Link href={`/admin?before=${entries[entries.length - 1].id}`} className="text-accent hover:underline">
              Older →
            </Link>
          )}
        </div>
      </section>
    </>
  );
}
