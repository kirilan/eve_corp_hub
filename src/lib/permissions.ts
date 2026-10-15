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

/**
 * Owners delete their own fits. Super users may also take down (moderate) public fits and fits
 * shared with their own corporation; they never touch private or link-only fits of others.
 */
export function canDeleteFitting(viewer: Viewer | null, fit: FitAccess): boolean {
  if (canEditFitting(viewer, fit)) return true;
  if (!viewer?.isSuperUser) return false;
  return fit.visibility === "public" || (fit.visibility === "corporation" && fit.corporationId === corporationOf(viewer));
}

/** Doctrines belong to a corporation and are maintained by its super users (by main character). */
export function canManageDoctrines(viewer: Viewer | null, corporationId?: number): boolean {
  const own = corporationOf(viewer);
  return viewer?.isSuperUser === true && own !== null && (corporationId === undefined || corporationId === own);
}

/** A doctrine can only hold fits its corporation's members can all see. */
export function fitsDoctrine(fit: FitAccess, corporationId: number): boolean {
  return fit.visibility === "public" || (fit.visibility === "corporation" && fit.corporationId === corporationId);
}

/** Audit entries for a corporation are read by its super users; site-wide entries by every super user. */
export function canReadAudit(viewer: Viewer | null, entryCorporationId: number | null): boolean {
  if (!viewer?.isSuperUser) return false;
  return entryCorporationId === null || entryCorporationId === corporationOf(viewer);
}

/** Sharing with a corporation means the owner's current main corporation, so a profile without one cannot. */
export function canShareWithCorporation(viewer: Viewer | null): boolean {
  return corporationOf(viewer) !== null;
}
