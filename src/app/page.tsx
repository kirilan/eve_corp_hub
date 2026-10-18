import Link from "next/link";
import { Suspense } from "react";
import { Notice } from "@/components/notice";
import { SignInButton } from "@/components/sign-in-button";
import { getViewer } from "@/lib/auth/viewer";
import { entityNames } from "@/lib/eve/names";
import { SITE_NAME } from "@/lib/site";

const FEATURES: { title: string; href: string; link: string; body: string }[] = [
  {
    title: "Keep your fits",
    href: "/fittings",
    link: "My fittings",
    body: "Paste a fit copied from EVE's fitting window or Pyfa, or import the fits saved on any of your characters. Every change is kept as a version you can look back at or restore.",
  },
  {
    title: "Share them",
    href: "/library",
    link: "Library",
    body: "Each fit is private, shared with your corporation, shared by link, or public. The Library lists your corporation's fits and the public ones; save a copy of any to make it your own.",
  },
  {
    title: "Send them to the game",
    href: "/fittings",
    link: "My fittings",
    body: "Write a fit to any of your characters' saved fittings, or tick up to 50 and send them in one go. Fits already on the character are skipped.",
  },
  {
    title: "Fly doctrines",
    href: "/doctrines",
    link: "Doctrines",
    body: "Corporation leaders group fits into doctrines. Members see their corporation's doctrines and can send every fit in one to a character at once.",
  },
  {
    title: "Track your income",
    href: "/income",
    link: "Personal income",
    body: "Chart bounties, ESS payouts, missions, market and contract sales and rewards across all your characters, with the taxes and fees on them. Only you can see it.",
  },
  {
    title: "All your alts, one profile",
    href: "/characters",
    link: "Characters",
    body: "Log in with your main, then add characters from any of your accounts. Your main's corporation decides which corporation fits and doctrines you see.",
  },
];

const STEPS: { title: string; body: React.ReactNode }[] = [
  {
    title: "Log in with your main",
    body: "EVE's own login page confirms which character you are. Logging in grants no access to any character data.",
  },
  {
    title: "Add your alts",
    body: (
      <>
        On <Link href="/characters" className="text-accent hover:underline">Characters</Link>, <em>Add a character</em>{" "}
        logs in again and attaches another character, from any of your accounts.
      </>
    ),
  },
  {
    title: "Choose what each character allows",
    body: (
      <>
        Also on Characters, per character: <em>Allow fitting sync</em> (read and write its saved fittings, for importing
        and sending fits) and <em>Allow income tracker</em> (read its wallet, for Personal income). Allow only what you
        use; revoke on the same page at any time.
      </>
    ),
  },
  {
    title: "Add fits",
    body: (
      <>
        <Link href="/fittings/new" className="text-accent hover:underline">New fit</Link> takes a pasted fit (in EVE,{" "}
        <em>Copy to clipboard</em> in the fitting window);{" "}
        <Link href="/fittings/import" className="text-accent hover:underline">Import from game</Link> lists the fits saved
        on a character.
      </>
    ),
  },
  {
    title: "Share and send",
    body: "Choose who can see a fit when you add or edit it. Send it from its page, or tick several on a list and send them together, to any of your characters that allow fitting sync.",
  },
];

export default function Home({ searchParams }: PageProps<"/">) {
  return (
    <div className="space-y-10">
      <Suspense>
        <Notice searchParams={searchParams} />
      </Suspense>
      <section className="space-y-3">
        <h1 className="text-3xl font-semibold">{SITE_NAME}</h1>
        <p className="max-w-2xl text-lg">Ship fittings, doctrines and income tracking for EVE Online pilots and their corporations.</p>
        <p className="max-w-2xl text-muted">
          Keep your fits in one place, share them with your corporation, and push them straight to any of your characters in
          game. One profile covers all your accounts: log in with your main, then add your alts.
        </p>
      </section>

      <Suspense fallback={<div className="h-24" />}>
        <Welcome />
      </Suspense>

      <section className="space-y-3">
        <h2 className="text-xl font-medium">What you can do</h2>
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map((feature) => (
            <li key={feature.title} className="flex flex-col gap-2 rounded border border-border bg-surface p-4">
              <h3 className="font-medium">{feature.title}</h3>
              <p className="flex-1 text-sm text-muted">{feature.body}</p>
              <Link href={feature.href} className="text-sm text-accent hover:underline">
                {feature.link} →
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-3">
        <h2 className="text-xl font-medium">Getting started</h2>
        <ol className="max-w-3xl space-y-3">
          {STEPS.map((step, i) => (
            <li key={step.title} className="flex gap-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border text-sm text-muted">
                {i + 1}
              </span>
              <div>
                <h3 className="font-medium">{step.title}</h3>
                <p className="text-sm text-muted">{step.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="max-w-3xl space-y-2 text-sm text-muted">
        <h2 className="text-base font-medium text-foreground">Your data</h2>
        <p>
          Private fits are seen by you alone. Wallet data is used only for your own income page: only income and the taxes
          and fees on it are stored, never transfers or purchases, and no other user, admins included, can see it. Access
          tokens are stored encrypted. Unlinking a character deletes its tokens and its wallet history.
        </p>
      </section>
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
          per character, what to allow.
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
        Corporation fits and doctrines you can see follow your main character&apos;s corporation.
      </p>
      <div className="mt-4 flex flex-wrap gap-2 text-sm">
        {[
          ["/fittings", "My fittings"],
          ["/library", "Library"],
          ["/doctrines", "Doctrines"],
          ["/income", "Personal income"],
          ["/characters", "Manage characters"],
        ].map(([href, label]) => (
          <Link key={href} href={href} className="rounded border border-border px-3 py-1.5 hover:border-accent">
            {label}
          </Link>
        ))}
      </div>
    </section>
  );
}
