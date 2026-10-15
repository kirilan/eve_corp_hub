"use client";

import { useState } from "react";

/**
 * The async Clipboard API exists only in secure contexts (HTTPS, localhost); plain-HTTP dev hosts
 * like http://ibox:3003 lack it. The fallback copies through a temporary selected textarea.
 */
async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied or document not focused: try the fallback.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    area.remove();
  }
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <button
      type="button"
      onClick={async () => {
        setStatus((await copyText(text)) ? "copied" : "failed");
        setTimeout(() => setStatus("idle"), 2000);
      }}
      className="rounded border border-border px-3 py-1.5 text-sm hover:border-accent"
    >
      {status === "copied" ? "Copied" : status === "failed" ? "Copy blocked: select and copy by hand" : label}
    </button>
  );
}
