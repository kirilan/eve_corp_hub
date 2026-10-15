import { listCharacters, type Viewer } from "@/lib/auth/accounts";
import { hasFeature } from "@/lib/eve/sso";
import { BULK_SEND_LIMIT, type FitRow } from "@/lib/fittings/store";
import { FitList } from "./fit-list";
import { FitPicker } from "./fit-picker";

/** The fit list, with bulk "send to game" when the viewer has a character that allows fitting sync. */
export async function FitCollection({
  fits,
  viewer,
  showOwner = false,
  empty,
}: {
  fits: FitRow[];
  viewer: Viewer | null;
  showOwner?: boolean;
  empty: React.ReactNode;
}) {
  const syncable = viewer ? (await listCharacters(viewer.userId)).filter((c) => hasFeature(c.scopes, "fittings")) : [];
  if (fits.length === 0 || syncable.length === 0) return <FitList fits={fits} showOwner={showOwner} empty={empty} />;
  return (
    <FitPicker
      // Only what the list shows crosses to the client; items and share tokens stay on the server.
      fits={fits.map(({ id, name, shipTypeId, shipName, visibility, ownerMainName }) => ({
        id,
        name,
        shipTypeId,
        shipName,
        visibility,
        ownerMainName,
      }))}
      characters={syncable.map(({ id, name }) => ({ id, name }))}
      limit={BULK_SEND_LIMIT}
      showOwner={showOwner}
    />
  );
}
