import Link from "next/link";
import { Suspense } from "react";
import { Notice } from "@/components/notice";
import { SignInButton } from "@/components/sign-in-button";
import { getViewer } from "@/lib/auth/viewer";
import { entityNames } from "@/lib/eve/names";
import { SITE_NAME } from "@/lib/site";

export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <div className="space-y-8">
      <Suspense>
        <Notice searchParams={searchParams} />
      </Suspense>
      <section className="space-y-3">
        <h1 className="text-3xl font-semibold">{SITE_NAME}</h1>
        <p className="max-w-2xl text-muted">
          Keep your ship fittings in one place, share them with your corporation, and push them straight to any of your
          characters in game. One profile covers all your accounts: log in with your main, then add your alts.
        </p>
      </section>
      <Suspense fallback={<div className="h-24" />}>
        <Welcome />
      </Suspense>
    </div>
  );
}

async function Welcome() {
  const viewer = await getViewer();
  if (!viewer) {
    return (
      <section className="space-y-3">
        <SignInButton />
        <p className="text-sm text-muted">
          Logging in only proves which character you are; it grants no access to your character data. You choose later,
          per character, whether to allow fitting sync.
        </p>
      </section>
    );
  }
  const corpId = viewer.main?.corporationId ?? null;
  const corpName = corpId ? (await entityNames([corpId]))[corpId] : undefined;
  return (
    <section className="rounded border border-border bg-surface p-5">
      <p>
        Signed in as <strong>{viewer.main?.name ?? "a profile without a main character"}</strong>
        {corpName && (
          <>
            {" "}
            of <strong>{corpName}</strong>
          </>
        )}
        .
      </p>
      <p className="mt-2 text-sm text-muted">
        Corporation fits you can see follow your main character&apos;s corporation.{" "}
        <Link href="/characters" className="text-accent hover:underline">
          Manage characters
        </Link>
      </p>
    </section>
  );
}
