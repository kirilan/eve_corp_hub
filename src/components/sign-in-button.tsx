/** Plain link, not next/link: /auth/login is a Route Handler that redirects off-site to EVE SSO. */
export function SignInButton({ compact = false, returnTo }: { compact?: boolean; returnTo?: string }) {
  const href = `/auth/login?intent=login${returnTo ? `&returnTo=${encodeURIComponent(returnTo)}` : ""}`;
  return (
    <a
      href={href}
      className={
        compact
          ? "rounded border border-border px-3 py-1.5 text-sm hover:border-accent"
          : "inline-flex items-center gap-2 rounded bg-accent px-5 py-2.5 font-medium text-black hover:brightness-110"
      }
    >
      Log in with EVE Online
    </a>
  );
}
