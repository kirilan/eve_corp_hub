import { Suspense } from "react";
import { FittingsTabs, TabBar } from "@/components/fittings/fittings-tabs";

/** My fittings, Library and Doctrines share one top-bar tab; these tabs switch between them. URLs are unchanged. */
export default function FittingsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {/* The current tab comes from the URL, which a prerendered shell does not know yet. */}
      <Suspense fallback={<TabBar />}>
        <FittingsTabs />
      </Suspense>
      {children}
    </>
  );
}
