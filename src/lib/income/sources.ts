/** Which wallet journal lines count as income or as charges on it, and how they are grouped. */
export const SOURCES = ["bounties", "ess", "missions", "market", "contracts", "rewards"] as const;
export type Source = (typeof SOURCES)[number];

export const SOURCE_LABELS: Record<Source, string> = {
  bounties: "Bounties",
  ess: "ESS payouts",
  missions: "Missions",
  market: "Market sales",
  contracts: "Contracts",
  rewards: "Other rewards",
};

/** The sources that make up ratting income: the tracker's original view, one click away. */
export const RATTING: readonly Source[] = ["bounties", "ess"];

// Only lines that bring ISK in. ISK moved between characters (donations, corporation payments)
// is left out: summed across a profile's own characters it would count the same ISK twice.
const REF_TYPES: Record<string, Source> = {
  // Paid in ticks every 20 minutes while killing NPCs, after corporation tax.
  bounty_prizes: "bounties",
  // The older per-kill payout line, still listed by ESI.
  bounty_prize: "bounties",
  // Main bank payout from an Encounter Surveillance System.
  ess_escrow_transfer: "ess",
  agent_mission_reward: "missions",
  agent_mission_time_bonus_reward: "missions",
  // A sell order filling, or selling into a buy order; buying is the same ref type with a negative amount.
  market_transaction: "market",
  // An item exchange or auction contract someone accepted, and courier rewards.
  contract_price: "contracts",
  contract_auction_sold: "contracts",
  contract_reward: "contracts",
  daily_goal_payouts: "rewards",
  milestone_reward_payment: "rewards",
  achievement_milestone_reward: "rewards",
  achievement_category_milestone_reward: "rewards",
  air_career_program_reward: "rewards",
  corporate_reward_payout: "rewards",
  project_payouts: "rewards",
  freelance_jobs_reward: "rewards",
  campaign_objective_isk_reward: "rewards",
  project_discovery_reward: "rewards",
  insurgency_corruption_contribution_reward: "rewards",
  insurgency_suppression_contribution_reward: "rewards",
  resource_wars_reward: "rewards",
  season_challenge_reward: "rewards",
  daily_challenge_reward: "rewards",
  opportunity_reward: "rewards",
};

/** What income costs: taxes and fees charged on it. Production costs (industry jobs, PI) are not tracked. */
export const EXPENSES = ["taxes", "fees"] as const;
export type Expense = (typeof EXPENSES)[number];

export const EXPENSE_LABELS: Record<Expense, string> = { taxes: "Taxes", fees: "Fees" };

/** Corporation tax is not a journal line of its own: it is the `tax` field of the payout it was withheld from. */
export const CORPORATION_TAX = "Corporation tax";

export type ExpenseLine = { source: Source; expense: Expense; label: string };

// Each charge belongs to the income it is charged on, so it follows that source's filter. Only
// negative lines are kept. The "*_corporation_tax" ref types are left out: they are the
// corporation's side of the same tax, already counted from the payout's `tax` field.
const EXPENSE_TYPES: Record<string, ExpenseLine> = {
  npc_bounty_security_tax: { source: "bounties", expense: "taxes", label: "Security tax" },
  agent_mission_security_tax: { source: "missions", expense: "taxes", label: "Security tax" },
  // Charged when placing or changing an order, filled or not.
  brokers_fee: { source: "market", expense: "fees", label: "Broker fees" },
  transaction_tax: { source: "market", expense: "taxes", label: "Sales tax" },
  market_provider_tax: { source: "market", expense: "taxes", label: "Sales tax" },
  market_security_tax: { source: "market", expense: "taxes", label: "Security tax" },
  contract_brokers_fee: { source: "contracts", expense: "fees", label: "Contract broker fees" },
  contract_sales_tax: { source: "contracts", expense: "taxes", label: "Sales tax" },
  contract_deposit_sales_tax: { source: "contracts", expense: "taxes", label: "Sales tax" },
  daily_goal_payouts_tax: { source: "rewards", expense: "taxes", label: "Reward tax" },
  project_discovery_tax: { source: "rewards", expense: "taxes", label: "Reward tax" },
  corporate_reward_tax: { source: "rewards", expense: "taxes", label: "Reward tax" },
};

/** Every ref type the tracker keeps: income and the charges on it. */
export const WALLET_REF_TYPES = [...Object.keys(REF_TYPES), ...Object.keys(EXPENSE_TYPES)];

/** The income source of an income ref type; null for anything else, charges included. */
export function sourceOf(refType: string): Source | null {
  return REF_TYPES[refType] ?? null;
}

/** The income source a charge belongs to, and how it is shown; null for anything that is not a tracked charge. */
export function expenseOf(refType: string): ExpenseLine | null {
  return EXPENSE_TYPES[refType] ?? null;
}

/** The ref types to read for some sources: their income and the charges on it. */
export function refTypesOf(sources: readonly Source[]): string[] {
  return WALLET_REF_TYPES.filter((refType) => sources.includes(REF_TYPES[refType] ?? EXPENSE_TYPES[refType].source));
}
