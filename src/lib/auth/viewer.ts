import "server-only";
import { cache } from "react";
import { loadViewer, refreshAffiliations, type Viewer } from "./accounts";
import { currentUserId } from "./session";

/**
 * The signed-in profile as permissions see it, or null. Reads the session cookie, so call it only
 * from components inside a <Suspense> boundary (Cache Components) or from Server Functions.
 */
export const getViewer = cache(async (): Promise<Viewer | null> => {
  const userId = await currentUserId();
  if (!userId) return null;
  await refreshAffiliations(userId);
  return loadViewer(userId);
});
