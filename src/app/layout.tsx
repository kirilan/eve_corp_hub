import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
import { Suspense } from "react";
import { UserMenu } from "@/components/user-menu";
import { SITE_NAME } from "@/lib/site";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: SITE_NAME, template: `%s · ${SITE_NAME}` },
  description: "Store, share and sync EVE Online ship fittings with your corporation.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="flex min-h-full flex-col font-sans">
        <header className="border-b border-border bg-surface">
          <nav className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
            <Link href="/" className="font-semibold tracking-wide text-accent">
              {SITE_NAME}
            </Link>
            {[
              ["/fittings", "My fittings"],
              ["/library", "Library"],
              ["/doctrines", "Doctrines"],
              ["/ratting", "Ratting"],
              ["/characters", "Characters"],
            ].map(([href, label]) => (
              <Link key={href} href={href} className="text-sm text-muted hover:text-foreground">
                {label}
              </Link>
            ))}
            <div className="ml-auto">
              {/* Reads the session cookie, so it streams in behind its own boundary. */}
              <Suspense fallback={<div className="h-8 w-24" />}>
                <UserMenu />
              </Suspense>
            </div>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
