import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import type { AuditEntry } from "@/db/schema";
import { AUDIT_PAGE_SIZE, readAudit } from "@/lib/audit";
import { listProfiles } from "@/lib/auth/super-users";
import { getViewer } from "@/lib/auth/viewer";
import { entityNames } from "@/lib/eve/names";
import { toggleSuperUser } from "./actions";

export const metadata: Metadata = { title: "Admin" };

export default function AdminPage({ searchParams }: PageProps<"/admin">) {
  return (
    <div className="space-y-8">
      <h1 className="text-2xl font-semibold">Admin</h1>
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
  // Not a hint that the page exists: anyone but a super user gets the ordinary 404.
  if (!viewer?.isSuperUser) notFound();
  const { before } = await searchParams;
  const beforeId = typeof before === "string" && /^\d+$/.test(before) ? Number(before) : undefined;
  const [profiles, entries] = await Promise.all([listProfiles(viewer), readAudit(viewer, { before: beforeId })]);
  const corpNames = await entityNames(profiles.map((p) => p.corporationId ?? 0));

  return (
    <>
      <section className="space-y-3">
        <h2 className="text-lg font-medium">Profiles</h2>
        <p className="text-sm text-muted">
          Super users manage their corporation&apos;s doctrines, can take down public fits and fits shared with their
          corporation, and can grant or revoke this flag. Every change is in the audit log below.
        </p>
        <ul className="divide-y divide-border rounded border border-border bg-surface text-sm">
          {profiles.map((profile) => (
            <li key={profile.userId} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
              <span className="font-medium">{profile.mainName ?? "No main character"}</span>
              <span className="text-muted">{profile.corporationId ? corpNames[profile.corporationId] ?? profile.corporationId : ""}</span>
              {profile.isSuperUser && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-xs text-accent">Super user</span>}
              {profile.userId !== viewer.userId && (
                <form action={toggleSuperUser.bind(null, profile.userId, !profile.isSuperUser)} className="ml-auto">
                  <button className="rounded border border-border px-3 py-1 hover:border-accent">
                    {profile.isSuperUser ? "Revoke super user" : "Make super user"}
                  </button>
                </form>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-lg font-medium">Audit log</h2>
        <p className="text-sm text-muted">
          Changes to shared fits, doctrines and super users in your corporation, plus site-wide ones. Private fits are not
          logged.
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
