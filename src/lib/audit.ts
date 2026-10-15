import "server-only";
import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { db, type Tx } from "@/db";
import { auditLog } from "@/db/schema";
import type { Viewer } from "@/lib/auth/accounts";
import { corporationOf } from "@/lib/permissions";

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
  | "user.super_revoked";

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

/** Newest first: the viewer's corporation's entries plus site-wide ones. Super users only. */
export async function readAudit(viewer: Viewer, options: { before?: number; subject?: { type: string; id: string } } = {}) {
  if (!viewer.isSuperUser) return [];
  const corporationId = corporationOf(viewer);
  const scope = corporationId === null ? isNull(auditLog.corporationId) : or(isNull(auditLog.corporationId), eq(auditLog.corporationId, corporationId));
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        scope,
        options.before ? lt(auditLog.id, options.before) : undefined,
        options.subject ? and(eq(auditLog.subjectType, options.subject.type), eq(auditLog.subjectId, options.subject.id)) : undefined,
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(PAGE);
}

export const AUDIT_PAGE_SIZE = PAGE;
