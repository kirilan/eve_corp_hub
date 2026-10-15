import "server-only";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { auditLog } from "@/db/schema";
import type { Viewer } from "@/lib/auth/accounts";
import { corporationOf, runsCorporation } from "@/lib/permissions";

export type AuditAction =
  | "fit.created"
  | "fit.edited"
  | "fit.restored"
  | "fit.shared"
  | "fit.deleted"
  | "doctrine.created"
  | "doctrine.edited"
  | "doctrine.deleted"
  | "doctrine.fit_added"
  | "doctrine.fit_removed"
  | "user.super_granted"
  | "user.super_revoked"
  | "user.director_granted"
  | "user.director_revoked";

export type AuditRecord = {
  action: AuditAction;
  subjectType: "fitting" | "doctrine" | "user";
  subjectId: string;
  subjectName: string;
  corporationId: number | null;
  details?: Record<string, unknown>;
};

/** Writes inside the caller's transaction, so an entry exists exactly when its change does. */
export async function audit(tx: Tx, actor: Viewer | null, record: AuditRecord): Promise<void> {
  await tx.insert(auditLog).values({
    actorId: actor?.userId ?? null,
    actorName: actor?.main?.name ?? null,
    details: {},
    ...record,
  });
}

/** Where a fit's audit entries are filed, or null when the change is private and not audited at all. */
export function fitAuditScope(fit: { visibility: string; corporationId: number | null }): { corporationId: number | null } | null {
  if (fit.visibility === "private") return null;
  return { corporationId: fit.visibility === "corporation" ? fit.corporationId : null };
}

const PAGE = 100;

/**
 * Newest first. Whoever runs the viewer's corporation (super user or active Corp Director) reads its
 * entries; super users also read the site-wide ones. Everyone else gets nothing.
 */
export async function readAudit(viewer: Viewer, options: { before?: number; subject?: { type: string; id: string } } = {}) {
  const corporationId = corporationOf(viewer);
  const ownCorporation = runsCorporation(viewer, corporationId) ? eq(auditLog.corporationId, corporationId!) : undefined;
  const siteWide = viewer.isSuperUser ? isNull(auditLog.corporationId) : undefined;
  if (!ownCorporation && !siteWide) return [];
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        or(ownCorporation, siteWide),
        options.before ? lt(auditLog.id, options.before) : undefined,
        options.subject ? and(eq(auditLog.subjectType, options.subject.type), eq(auditLog.subjectId, options.subject.id)) : undefined,
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(PAGE);
}

export const AUDIT_PAGE_SIZE = PAGE;
