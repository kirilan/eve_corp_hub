import {
  COPYING,
  decryptorCandidates,
  type Decryptor,
  INVENTED_BLUEPRINTS,
  INVENTED_ME,
  INVENTION,
  inventionFor,
  MANUFACTURING,
  REACTIONS,
  recipeFor,
  requiredQuantity,
} from "./recipes";

/**
 * Trade profit from market transactions and industry jobs, first in, first out. Pure.
 *
 * Every purchase is a lot. An industry job consumes its recipe's materials from the oldest lots when
 * it starts, and when it finishes its product becomes a lot carrying the whole cost: materials, the
 * blueprint copy runs it used, and the job's fee. Chains of any length follow: a component built
 * from bought minerals is a lot like any other, and the job that uses it takes its cost along. A
 * sale takes units from the oldest lots of that item across all of the profile's characters.
 *
 * The rules are eve-skills' ledger's (ledger.py), except that lots are first in, first out:
 * - A job's materials come from the SDE recipe at the blueprint's ME: ESI never lists what a job
 *   consumed. Structure and rig bonuses are not reported, so a structure job is costed without them.
 * - Materials with no purchase on record (mined, looted, reprocessed, bought before tracking began)
 *   are valued at EVE's average price and counted as estimated; never as free.
 * - Invention consumes its data cores, one copy run per attempt and the decryptor read off the copies
 *   it made; its whole cost, failures included, lands on the copy runs it produced, and a T2 job takes
 *   the cost of the runs it used.
 * - Units sold with no purchase or build on record have no known cost: they are counted apart, not
 *   as profit. Broker fees are not per item and are left to the caller.
 */

export type Trade = {
  characterId: number;
  transactionId: number;
  date: Date;
  typeId: number;
  quantity: number;
  unitPrice: number;
  isBuy: boolean;
  // Sales tax charged on this sale, as a positive amount; 0 for purchases and when unknown.
  tax: number;
};

export type Job = {
  characterId: number;
  jobId: number;
  activityId: number;
  blueprintId: number;
  blueprintTypeId: number;
  productTypeId: number | null;
  runs: number;
  licensedRuns: number | null;
  successfulRuns: number | null;
  cost: number | null;
  status: string;
  facilityId: number;
  startDate: Date;
  endDate: Date;
  completedDate: Date | null;
};

export type BlueprintSeen = { itemId: number; typeId: number; me: number; te: number; quantity: number; firstSeen: Date };

export type Sale = {
  characterId: number;
  typeId: number;
  date: Date;
  quantity: number;
  revenue: number;
  tax: number;
  // Units that came from a recorded purchase or build, what they sold for, and what they cost.
  matched: number;
  matchedRevenue: number;
  cost: number;
  // Of that cost, ISK valued at market for materials with no purchase on record.
  estimated: number;
  // Matched units that a job of the profile built.
  built: number;
  // matchedRevenue - cost - the sales tax on the matched units.
  profit: number;
};

export type Lot = {
  characterId: number;
  typeId: number;
  date: Date;
  quantity: number;
  unitCost: number;
  unitEstimated: number;
  built: boolean;
};

export const NOTES = [
  "structureJobs",
  "unknownMe",
  "meFromSiblings",
  "meAssumedInvented",
  "unknownDecryptor",
  "ambiguousDecryptor",
  "missingRecipe",
  "missingCopyRuns",
  "unpricedUnits",
] as const;
export type Note = (typeof NOTES)[number];

export type Industry = {
  // Jobs started and not finished: their materials are spent, their product not yet out.
  inProgress: { jobs: number; cost: number };
  // Cancelled or reverted jobs: what they consumed is gone.
  lost: { jobs: number; cost: number };
  // Research fees: real costs no item carries.
  research: { jobs: number; cost: number };
  // Materials taken with no purchase on record: units and their estimated value.
  estimated: { units: number; value: number };
  notes: Partial<Record<Note, number>>;
};

export type Matched = { sales: Sale[]; lots: Lot[]; industry: Industry };

const NPC_STATIONS = { from: 60_000_000, to: 64_000_000 };
const FINISHED = new Set(["delivered", "ready"]);
const LOST = new Set(["cancelled", "reverted"]);

type Pool = { runs: number; cost: number; estimated: number };
type Spent = { cost: number; estimated: number; built: number; short: number };
type JobCost = { cost: number; estimated: number; decryptor: Decryptor | null };

/** Matches sales to purchases and builds, oldest first, replaying jobs in time order. */
export function matchTrades(
  trades: Trade[],
  options: { jobs?: Job[]; blueprints?: BlueprintSeen[]; prices?: Record<number, number> } = {},
): Matched {
  const { jobs = [], blueprints = [], prices = {} } = options;
  const open = new Map<number, Lot[]>();
  const copies = new Map<number, Pool>();
  const sales: Sale[] = [];
  const running = new Map<number, JobCost>();
  const industry: Industry = {
    inProgress: { jobs: 0, cost: 0 },
    lost: { jobs: 0, cost: 0 },
    research: { jobs: 0, cost: 0 },
    estimated: { units: 0, value: 0 },
    notes: {},
  };
  const note = (key: Note, count = 1) => (industry.notes[key] = (industry.notes[key] ?? 0) + count);
  const lotsOf = (typeId: number) => {
    let lots = open.get(typeId);
    if (!lots) open.set(typeId, (lots = []));
    return lots;
  };
  const poolOf = (blueprintTypeId: number) => {
    let pool = copies.get(blueprintTypeId);
    if (!pool) copies.set(blueprintTypeId, (pool = { runs: 0, cost: 0, estimated: 0 }));
    return pool;
  };
  const seen = new Map(blueprints.map((b) => [b.itemId, b]));
  const bought = new Set(trades.filter((t) => t.isBuy).map((t) => t.typeId));

  /** Units of an item from the oldest lots; what is missing is left for the caller to value. */
  function take(typeId: number, quantity: number): Spent {
    const lots = lotsOf(typeId);
    const spent: Spent = { cost: 0, estimated: 0, built: 0, short: quantity };
    while (spent.short > 0 && lots.length > 0) {
      const lot = lots[0];
      const units = Math.min(spent.short, lot.quantity);
      spent.cost += units * lot.unitCost;
      spent.estimated += units * lot.unitEstimated;
      if (lot.built) spent.built += units;
      lot.quantity -= units;
      spent.short -= units;
      if (lot.quantity === 0) lots.shift();
    }
    return spent;
  }

  /** Materials for a job: from stock, and at EVE's average price for what stock does not hold. */
  function consume(typeId: number, quantity: number, into: JobCost) {
    const spent = take(typeId, quantity);
    into.cost += spent.cost;
    into.estimated += spent.estimated;
    if (spent.short <= 0) return;
    const price = prices[typeId];
    if (!price) {
      note("unpricedUnits", spent.short);
      return;
    }
    into.cost += spent.short * price;
    into.estimated += spent.short * price;
    industry.estimated.units += spent.short;
    industry.estimated.value += spent.short * price;
  }

  function drawCopyRuns(blueprintTypeId: number, runs: number, into: JobCost) {
    const pool = poolOf(blueprintTypeId);
    const used = Math.min(runs, pool.runs);
    if (used > 0) {
      const share = used / pool.runs;
      into.cost += pool.cost * share;
      into.estimated += pool.estimated * share;
      pool.cost -= pool.cost * share;
      pool.estimated -= pool.estimated * share;
      pool.runs -= used;
    }
    if (runs > used) note("missingCopyRuns", runs - used);
  }

  /** The decryptor an invention of `blueprintTypeId` used, read off the copies seen of it (the nearest after `after`). */
  function decryptorFor(blueprintTypeId: number, after: Date | null): { known: boolean; decryptor: Decryptor | null } {
    const made = blueprints.filter((b) => b.typeId === blueprintTypeId && b.quantity === -2);
    if (made.length === 0) return { known: false, decryptor: null };
    const later = after ? made.filter((b) => b.firstSeen >= after).sort((a, b) => a.firstSeen.getTime() - b.firstSeen.getTime()) : [];
    let pick = later[0];
    if (!pick) {
      const counts = new Map<string, { n: number; b: BlueprintSeen }>();
      for (const b of made) {
        const key = `${b.me}/${b.te}`;
        counts.set(key, { n: (counts.get(key)?.n ?? 0) + 1, b });
      }
      pick = [...counts.values()].sort((a, b) => b.n - a.n)[0].b;
    }
    const candidates = decryptorCandidates(pick.me, pick.te);
    if (candidates.length === 0) return { known: false, decryptor: null };
    if (candidates.length > 1) {
      // Two decryptors give the same copy; the one the profile has bought is the one it used.
      const owned = candidates.filter((d) => d !== null && bought.has(d.typeId));
      if (owned.length === 1) return { known: true, decryptor: owned[0] };
      note("ambiguousDecryptor");
    }
    return { known: true, decryptor: candidates[0] };
  }

  function meFor(job: Job): number {
    const own = seen.get(job.blueprintId);
    if (own) return own.me;
    if (INVENTED_BLUEPRINTS.has(job.blueprintTypeId)) {
      const { known, decryptor } = decryptorFor(job.blueprintTypeId, null);
      note("meAssumedInvented");
      return INVENTED_ME + (known && decryptor ? decryptor.me : 0);
    }
    const siblings = blueprints.filter((b) => b.typeId === job.blueprintTypeId);
    if (siblings.length > 0) {
      note("meFromSiblings");
      const counts = new Map<number, number>();
      for (const b of siblings) counts.set(b.me, (counts.get(b.me) ?? 0) + 1);
      return [...counts].sort((a, b) => b[1] - a[1])[0][0];
    }
    note("unknownMe");
    return 0;
  }

  /** Whether a job's blueprint is a copy, whose runs carry a cost; an unseen one is a copy only if invention makes it. */
  function isCopy(job: Job): boolean {
    const own = seen.get(job.blueprintId);
    return own ? own.quantity === -2 : INVENTED_BLUEPRINTS.has(job.blueprintTypeId);
  }

  function start(job: Job) {
    const cost: JobCost = { cost: job.cost ?? 0, estimated: 0, decryptor: null };
    running.set(job.jobId, cost);
    const built = job.activityId === MANUFACTURING || REACTIONS.includes(job.activityId);
    if (built && (job.facilityId < NPC_STATIONS.from || job.facilityId >= NPC_STATIONS.to)) note("structureJobs");
    if (built) {
      const recipe = recipeFor(job.activityId, job.blueprintTypeId);
      if (!recipe) return void note("missingRecipe");
      // Reaction formulas have no material efficiency.
      const me = job.activityId === MANUFACTURING ? meFor(job) : 0;
      for (const [material, base] of recipe.materials) consume(material, requiredQuantity(base, job.runs, me), cost);
      if (job.activityId === MANUFACTURING && isCopy(job)) drawCopyRuns(job.blueprintTypeId, job.runs, cost);
    } else if (job.activityId === INVENTION) {
      const row = inventionFor(job.blueprintTypeId);
      if (!row) return void note("missingRecipe");
      for (const [material, perAttempt] of row.materials) consume(material, perAttempt * job.runs, cost);
      if (job.productTypeId !== null) {
        const { known, decryptor } = decryptorFor(job.productTypeId, job.endDate);
        if (!known) note("unknownDecryptor");
        cost.decryptor = decryptor;
        if (decryptor) consume(decryptor.typeId, job.runs, cost);
      }
      drawCopyRuns(job.blueprintTypeId, job.runs, cost);
    }
  }

  function finish(job: Job) {
    const cost = running.get(job.jobId);
    if (!cost) return;
    running.delete(job.jobId);
    if (job.activityId === MANUFACTURING || REACTIONS.includes(job.activityId)) {
      const recipe = recipeFor(job.activityId, job.blueprintTypeId);
      if (!recipe) return;
      const quantity = job.runs * recipe.units;
      lotsOf(recipe.product).push({
        characterId: job.characterId,
        typeId: recipe.product,
        date: job.completedDate ?? job.endDate,
        quantity,
        unitCost: cost.cost / quantity,
        unitEstimated: cost.estimated / quantity,
        built: true,
      });
    } else if (job.activityId === COPYING) {
      const pool = poolOf(job.blueprintTypeId);
      pool.runs += job.runs * (job.licensedRuns ?? 1);
      pool.cost += cost.cost;
      pool.estimated += cost.estimated;
    } else if (job.activityId === INVENTION) {
      if (job.productTypeId === null || job.successfulRuns === null) return;
      const base = inventionFor(job.blueprintTypeId)?.products.find((p) => p.blueprint === job.productTypeId)?.runs ?? 1;
      // Failed attempts add their cost too: the next success absorbs it.
      const pool = poolOf(job.productTypeId);
      pool.runs += job.successfulRuns * (base + (cost.decryptor?.runs ?? 0));
      pool.cost += cost.cost;
      pool.estimated += cost.estimated;
    } else {
      industry.research.jobs++;
      industry.research.cost += cost.cost;
    }
  }

  function sell(trade: Trade) {
    const spent = take(trade.typeId, trade.quantity);
    const matched = trade.quantity - spent.short;
    const revenue = trade.quantity * trade.unitPrice;
    const matchedRevenue = matched * trade.unitPrice;
    const matchedTax = trade.tax * (matched / trade.quantity);
    sales.push({
      characterId: trade.characterId,
      typeId: trade.typeId,
      date: trade.date,
      quantity: trade.quantity,
      revenue,
      tax: trade.tax,
      matched,
      matchedRevenue,
      cost: spent.cost,
      estimated: spent.estimated,
      built: spent.built,
      profit: matched > 0 ? matchedRevenue - spent.cost - matchedTax : 0,
    });
  }

  // Purchases, then finished jobs, then jobs starting, then sales, when several fall in the same second.
  type Event = { at: number; order: number; id: number; run: () => void };
  const events: Event[] = [];
  for (const trade of trades) {
    if (trade.quantity <= 0) continue;
    const run = trade.isBuy
      ? () =>
          lotsOf(trade.typeId).push({
            characterId: trade.characterId,
            typeId: trade.typeId,
            date: trade.date,
            quantity: trade.quantity,
            unitCost: trade.unitPrice,
            unitEstimated: 0,
            built: false,
          })
      : () => sell(trade);
    events.push({ at: trade.date.getTime(), order: trade.isBuy ? 0 : 3, id: trade.transactionId, run });
  }
  for (const job of jobs) {
    if (job.runs <= 0) continue;
    events.push({ at: job.startDate.getTime(), order: 2, id: job.jobId, run: () => start(job) });
    if (FINISHED.has(job.status)) events.push({ at: (job.completedDate ?? job.endDate).getTime(), order: 1, id: job.jobId, run: () => finish(job) });
  }
  events.sort((a, b) => a.at - b.at || a.order - b.order || a.id - b.id);
  for (const event of events) event.run();

  for (const job of jobs) {
    const cost = running.get(job.jobId);
    if (!cost) continue;
    const bucket = LOST.has(job.status) ? industry.lost : industry.inProgress;
    bucket.jobs++;
    bucket.cost += cost.cost;
  }
  return { sales, lots: [...open.values()].flat(), industry };
}

/** Figures for a set of sales: an item, a category, a day. */
export type SaleFigures = {
  sold: number;
  revenue: number;
  tax: number;
  matched: number;
  matchedRevenue: number;
  cost: number;
  estimated: number;
  built: number;
  profit: number;
  // Units and revenue with no purchase or build on record.
  unmatched: number;
  unmatchedRevenue: number;
};

export const emptyFigures = (): SaleFigures => ({
  sold: 0,
  revenue: 0,
  tax: 0,
  matched: 0,
  matchedRevenue: 0,
  cost: 0,
  estimated: 0,
  built: 0,
  profit: 0,
  unmatched: 0,
  unmatchedRevenue: 0,
});

export function addSale(into: SaleFigures, sale: Sale): SaleFigures {
  into.sold += sale.quantity;
  into.revenue += sale.revenue;
  into.tax += sale.tax;
  into.matched += sale.matched;
  into.matchedRevenue += sale.matchedRevenue;
  into.cost += sale.cost;
  into.estimated += sale.estimated;
  into.built += sale.built;
  into.profit += sale.profit;
  into.unmatched += sale.quantity - sale.matched;
  into.unmatchedRevenue += sale.revenue - sale.matchedRevenue;
  return into;
}

/** Profit as a share of what the matched units sold for; null with nothing matched. */
export function margin(figures: SaleFigures): number | null {
  return figures.matchedRevenue > 0 ? figures.profit / figures.matchedRevenue : null;
}

export type Holding = {
  typeId: number;
  quantity: number;
  cost: number;
  estimated: number;
  // Units of it a job built, the rest were bought.
  built: number;
  oldest: Date;
  newest: Date;
};

/** Unsold lots per item: units, what they cost, how many were built, and when the oldest and newest arrived. */
export function holdings(lots: Lot[]): Holding[] {
  const byType = new Map<number, Holding>();
  for (const lot of lots) {
    if (lot.quantity <= 0) continue;
    let held = byType.get(lot.typeId);
    if (!held) byType.set(lot.typeId, (held = { typeId: lot.typeId, quantity: 0, cost: 0, estimated: 0, built: 0, oldest: lot.date, newest: lot.date }));
    held.quantity += lot.quantity;
    held.cost += lot.quantity * lot.unitCost;
    held.estimated += lot.quantity * lot.unitEstimated;
    if (lot.built) held.built += lot.quantity;
    if (lot.date < held.oldest) held.oldest = lot.date;
    if (lot.date > held.newest) held.newest = lot.date;
  }
  return [...byType.values()];
}
