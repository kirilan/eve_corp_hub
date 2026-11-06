"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  ["/fittings", "My fittings"],
  ["/library", "Library"],
  ["/doctrines", "Doctrines"],
] as const;

/** My fittings, Library and Doctrines: one top-bar tab, switched between here. */
export function FittingsTabs() {
  const pathname = usePathname();
  // A fit's own pages (/fittings/123) belong to whichever list it was opened from; mark none of them.
  const current = TABS.find(([href]) => pathname === href || (href !== "/fittings" && pathname.startsWith(`${href}/`)))?.[0];
  return <TabBar current={current} />;
}

/** The tabs themselves; with no `current`, as rendered before the URL is known. */
export function TabBar({ current }: { current?: string }) {
  return (
    <nav aria-label="Fittings" className="mb-6 flex gap-1 border-b border-border">
      {TABS.map(([href, label]) => (
        <Link
          key={href}
          href={href}
          aria-current={current === href ? "page" : undefined}
          className={`-mb-px border-b-2 px-3 py-2 text-sm ${
            current === href ? "border-accent text-foreground" : "border-transparent text-muted hover:text-foreground"
          }`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
