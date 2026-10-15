import type { Visibility } from "@/lib/fittings/store";

export const VISIBILITY_LABEL: Record<Visibility, string> = {
  private: "Private",
  corporation: "Corporation",
  link: "Link only",
  public: "Public",
};

const TONE: Record<Visibility, string> = {
  private: "border-border text-muted",
  corporation: "border-sky-700/70 text-sky-300",
  link: "border-violet-700/70 text-violet-300",
  public: "border-emerald-700/70 text-emerald-300",
};

export function VisibilityBadge({ visibility }: { visibility: Visibility }) {
  return <span className={`rounded border px-1.5 py-0.5 text-xs ${TONE[visibility]}`}>{VISIBILITY_LABEL[visibility]}</span>;
}
