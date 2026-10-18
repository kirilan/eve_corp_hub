import type { Fitting } from "@/db/schema";
import type { Viewer } from "@/lib/auth/accounts";

/**
 * Who sees what. The guiding rule: a profile acts as its main character's corporation. Switching
 * main to a character in another corp switches which corporation fits the profile can see.
 *
 * - private:     owner only
 * - corporation: owner, plus profiles whose main is in the corporation the fit was shared with
 * - link:        owner, plus anyone holding the share link (signed in or not); never listed
 * - public:      everyone, signed in or not, and listed in the public library
 */
type FitAccess = Pick<Fitting, "ownerId" | "visibility" | "corporationId" | "shareToken">;

/**
 * Two admin tiers:
 * - Super user: site-wide. Runs their main's corporation, moderates every public fit, sees every
 *   profile and the site-wide audit entries, and grants both roles.
 * - Corp Director: the same powers, but only for the one corporation the role names, and only
 *   while their main is in it. Public fits count as "theirs" when the owner's main is in that corp.
 */

export function corporationOf(viewer: Viewer | null): number | null {
  return viewer?.main?.corporationId ?? null;
}

export function canViewFitting(viewer: Viewer | null, fit: FitAccess, presentedShareToken?: string): boolean {
  if (viewer && viewer.userId === fit.ownerId) return true;
  switch (fit.visibility) {
    case "public":
      return true;
    case "link":
      return presentedShareToken !== undefined && fit.shareToken !== null && presentedShareToken === fit.shareToken;
    case "corporation":
      return fit.corporationId !== null && corporationOf(viewer) === fit.corporationId;
    case "private":
      return false;
  }
}

export function canEditFitting(viewer: Viewer | null, fit: FitAccess): boolean {
  return viewer !== null && viewer.userId === fit.ownerId;
}

/** True when the viewer's main is in their Corp Director corporation. */
export function isActiveDirector(viewer: Viewer | null): boolean {
  const own = corporationOf(viewer);
  return own !== null && (viewer?.directorOf.includes(own) ?? false);
}

/** May this viewer run (moderate, manage doctrines for, administer) this corporation? */
export function runsCorporation(viewer: Viewer | null, corporationId: number | null | undefined): boolean {
  const own = corporationOf(viewer);
  if (own === null || corporationId !== own) return false;
  return viewer!.isSuperUser || isActiveDirector(viewer);
}

/** Shows the admin page at all: super users, and directors whose role is in effect. */
export function canAdminister(viewer: Viewer | null): boolean {
  return viewer?.isSuperUser === true || isActiveDirector(viewer);
}

/** The site's health panel (scheduled jobs, dependencies, site-wide counts): super users only, not directors. */
export function canViewSystemHealth(viewer: Viewer | null): boolean {
  return viewer?.isSuperUser === true;
}

/**
 * Owners delete their own fits. Admins may also take down (moderate) shared fits: fits shared with
 * a corporation they run, and public fits - any of them for super users, those whose owner's main
 * is in their corporation for directors. Nobody touches someone else's private or link-only fits.
 */
export function canDeleteFitting(viewer: Viewer | null, fit: FitAccess & { ownerCorporationId?: number | null }): boolean {
  if (canEditFitting(viewer, fit)) return true;
  if (fit.visibility === "corporation") return runsCorporation(viewer, fit.corporationId);
  if (fit.visibility === "public") return viewer?.isSuperUser === true || runsCorporation(viewer, fit.ownerCorporationId);
  return false;
}

/** Doctrines belong to a corporation and are maintained by whoever runs it (super user or director). */
export function canManageDoctrines(viewer: Viewer | null, corporationId?: number): boolean {
  return runsCorporation(viewer, corporationId ?? corporationOf(viewer));
}

/** A doctrine can only hold fits its corporation's members can all see. */
export function fitsDoctrine(fit: FitAccess, corporationId: number): boolean {
  return fit.visibility === "public" || (fit.visibility === "corporation" && fit.corporationId === corporationId);
}

/** Corporation entries go to whoever runs that corporation; site-wide entries to super users only. */
export function canReadAudit(viewer: Viewer | null, entryCorporationId: number | null): boolean {
  if (entryCorporationId === null) return viewer?.isSuperUser === true;
  return runsCorporation(viewer, entryCorporationId);
}

/**
 * Granting roles. Super user: super users only, never on themselves. Corp Director: super users for
 * anyone, directors for profiles whose main is in their own corporation; never on themselves.
 */
export function canGrantSuperUser(viewer: Viewer | null, targetUserId: string): boolean {
  return viewer?.isSuperUser === true && viewer.userId !== targetUserId;
}

export function canGrantDirector(viewer: Viewer | null, target: { userId: string; corporationId: number | null }): boolean {
  if (!viewer || viewer.userId === target.userId || target.corporationId === null) return false;
  return viewer.isSuperUser || (isActiveDirector(viewer) && target.corporationId === corporationOf(viewer));
}

/** Sharing with a corporation means the owner's current main corporation, so a profile without one cannot. */
export function canShareWithCorporation(viewer: Viewer | null): boolean {
  return corporationOf(viewer) !== null;
}
