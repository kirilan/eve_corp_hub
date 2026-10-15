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

/** Admins may take down a shared fit (abuse, spam); they never get to read private ones. */
export function canDeleteFitting(viewer: Viewer | null, fit: FitAccess): boolean {
  return canEditFitting(viewer, fit) || (viewer?.isAdmin === true && fit.visibility !== "private");
}

/** Sharing with a corporation means the owner's current main corporation, so a profile without one cannot. */
export function canShareWithCorporation(viewer: Viewer | null): boolean {
  return corporationOf(viewer) !== null;
}
