/** Which wallet journal lines count as ratting income, and how they are grouped. */
export const SOURCES = ["bounties", "ess"] as const;
export type Source = (typeof SOURCES)[number];

export const SOURCE_LABELS: Record<Source, string> = { bounties: "Bounties", ess: "ESS payouts" };

const REF_TYPES: Record<string, Source> = {
  // Paid in ticks every 20 minutes while killing NPCs, after corporation tax.
  bounty_prizes: "bounties",
  // The older per-kill payout line, still listed by ESI.
  bounty_prize: "bounties",
  // Main bank payout from an Encounter Surveillance System.
  ess_escrow_transfer: "ess",
};

export const RATTING_REF_TYPES = Object.keys(REF_TYPES);

export function sourceOf(refType: string): Source | null {
  return REF_TYPES[refType] ?? null;
}
