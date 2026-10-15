import Image from "next/image";
import Link from "next/link";
import { getViewer } from "@/lib/auth/viewer";
import { portraitUrl } from "@/lib/eve/names";
import { SignInButton } from "./sign-in-button";

export async function UserMenu() {
  const viewer = await getViewer();
  if (!viewer) return <SignInButton compact />;
  return (
    <div className="flex items-center gap-3">
      {viewer.main && (
        <>
          <Image
            src={portraitUrl(viewer.main.id, 64)}
            alt=""
            width={28}
            height={28}
            unoptimized
            className="rounded-full"
          />
          <span className="text-sm">{viewer.main.name}</span>
        </>
      )}
      {viewer.isSuperUser && (
        <Link href="/admin" className="text-sm text-accent hover:underline">
          Admin
        </Link>
      )}
      <form action="/auth/logout" method="post">
        <button className="text-sm text-muted hover:text-foreground">Sign out</button>
      </form>
    </div>
  );
}
