import Link from "next/link";
import { changeVisibility, copyFit, removeFit } from "@/app/fittings/actions";
import { listCharacters, type Viewer } from "@/lib/auth/accounts";
import { env } from "@/lib/env";
import { hasFeature } from "@/lib/eve/sso";
import { entityNames } from "@/lib/eve/names";
import { VISIBILITIES, type FitRow } from "@/lib/fittings/store";
import { canDeleteFitting, canEditFitting, canShareWithCorporation } from "@/lib/permissions";
import { CopyButton } from "./copy-button";
import { FitView } from "./fit-view";
import { SendToGame } from "./send-to-game";
import { VISIBILITY_LABEL, VisibilityBadge } from "./visibility-badge";

/** A fit with everything the viewer may do with it. `shareToken` is set when it was opened through a share link. */
export async function FitDetail({ fit, viewer, shareToken }: { fit: FitRow; viewer: Viewer | null; shareToken: string | null }) {
  const isOwner = canEditFitting(viewer, fit);
  const syncable = viewer
    ? (await listCharacters(viewer.userId)).filter((character) => hasFeature(character.scopes, "fittings"))
    : [];
  const corporationName =
    fit.visibility === "corporation" && fit.corporationId ? (await entityNames([fit.corporationId]))[fit.corporationId] : undefined;
  const shareUrl = fit.visibility === "link" && fit.shareToken ? `${env().APP_URL}/s/${fit.shareToken}` : null;

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{fit.name}</h1>
          <VisibilityBadge visibility={fit.visibility} />
        </div>
        <p className="text-sm text-muted">
          {fit.shipName ?? `Type ${fit.shipTypeId}`}
          {fit.ownerMainName && <> · by {fit.ownerMainName}</>}
          {corporationName && <> · shared with {corporationName}</>} · updated {fit.updatedAt.toISOString().slice(0, 10)}
        </p>
      </div>

      <div className="grid gap-4 rounded border border-border bg-surface p-4 md:grid-cols-2">
        {viewer ? (
          <div className="space-y-2">
            <h2 className="text-sm font-medium">Send to a character</h2>
            <SendToGame fitId={fit.id} shareToken={shareToken} characters={syncable.map(({ id, name }) => ({ id, name }))} />
          </div>
        ) : (
          <p className="text-sm text-muted">
            <a href={`/auth/login?intent=login&returnTo=${encodeURIComponent(shareToken ? `/s/${shareToken}` : `/fittings/${fit.id}`)}`} className="text-accent hover:underline">
              Log in
            </a>{" "}
            to save this fit or send it to your characters.
          </p>
        )}

        <div className="space-y-3">
          {isOwner && (
            <>
              <form action={changeVisibility.bind(null, fit.id)} className="flex flex-wrap items-center gap-2">
                <select name="visibility" defaultValue={fit.visibility} className="rounded border border-border bg-background px-2 py-1.5 text-sm">
                  {VISIBILITIES.map((visibility) => (
                    <option
                      key={visibility}
                      value={visibility}
                      disabled={visibility === "corporation" && fit.visibility !== "corporation" && !canShareWithCorporation(viewer)}
                    >
                      {VISIBILITY_LABEL[visibility]}
                    </option>
                  ))}
                </select>
                <button className="rounded border border-border px-3 py-1.5 text-sm hover:border-accent">Update sharing</button>
              </form>
              {shareUrl && (
                <div className="flex items-center gap-2">
                  <code className="truncate rounded bg-background px-2 py-1 text-xs">{shareUrl}</code>
                  <CopyButton text={shareUrl} label="Copy link" />
                </div>
              )}
            </>
          )}
          <div className="flex flex-wrap gap-2">
            {isOwner && (
              <Link href={`/fittings/${fit.id}/edit`} className="rounded border border-border px-3 py-1.5 text-sm hover:border-accent">
                Edit
              </Link>
            )}
            {viewer && !isOwner && (
              <form action={copyFit.bind(null, fit.id, shareToken)}>
                <button className="rounded border border-border px-3 py-1.5 text-sm hover:border-accent">Save a copy</button>
              </form>
            )}
            {canDeleteFitting(viewer, fit) && (
              // A second click to delete, without needing client-side JavaScript.
              <details className="relative">
                <summary className="cursor-pointer list-none rounded border border-border px-3 py-1.5 text-sm text-red-300 hover:border-red-400">
                  Delete…
                </summary>
                <form action={removeFit.bind(null, fit.id)} className="absolute z-10 mt-1">
                  <button className="rounded bg-red-700 px-3 py-1.5 text-sm whitespace-nowrap text-white hover:bg-red-600">
                    Yes, delete {isOwner ? "this fit" : "as admin"}
                  </button>
                </form>
              </details>
            )}
          </div>
        </div>
      </div>

      <FitView fit={fit} />
    </div>
  );
}
