import Image from "next/image";
import Link from "next/link";
import { io } from "next/cache";
import { typeIconUrl } from "@/lib/eve/images";
import { formatIsk } from "@/lib/income/format";
import { utcDay } from "@/lib/pvp/comps/days";
import { mixLabel, ROLES, type Mix, type Role } from "@/lib/pvp/comps/roles";
import { MIN_FIGHTS, SOLID_FIGHTS, type CompResults, type GrowthStep, type HullStat, type MixStat } from "@/lib/pvp/comps/score";
import { compMonths, hullNames, LIVE_DAYS, liveComps, monthComps } from "@/lib/pvp/comps/view";

const PATH = "/doctrines/comps";
const ROLE_LABEL: Record<Role, string> = { dps: "DPS", tackle: "Tackle", logi: "Logi", ewar: "EWAR", links: "Links" };
const ROLE_NOTE: Record<Role, string> = {
  dps: "Everything not below.",
  tackle: "Interceptors, interdictors, heavy interdictors.",
  logi: "Logistics cruisers and frigates, force auxiliaries. Listed by how often they flew: logi lands on killmails mostly when it dies, so its win rate says little.",
  ewar: "Force and combat recons, electronic attack frigates.",
  links: "Command ships and command destroyers.",
};
// Hulls listed per role before "show all".
const HULLS_SHOWN = 10;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (month: string) => `${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;
const dayLabel = (day: string) => `${Number(day.slice(8, 10))} ${MONTHS[Number(day.slice(5, 7)) - 1]}`;
const percent = (part: number, whole: number) => `${Math.round((100 * part) / whole)}%`;
const plural = (n: number, word: string) => `${n.toLocaleString("en")} ${word}${n === 1 ? "" : "s"}`;

type Params = Record<string, string | string[] | undefined>;

/**
 * The small-gang fleet comps: for the last 30 days, or a saved month with `?month=YYYY-MM`. Public:
 * shown to everyone, signed in or not.
 */
export async function FleetComps({ searchParams }: { searchParams: Promise<Params> }) {
  // Awaited first, so this reads at request time (from the cache), never while prerendering at build.
  const params = await searchParams;
  const months = await compMonths();
  const month = typeof params.month === "string" && months.includes(params.month) ? params.month : null;
  let period;
  if (month) period = await monthComps(month);
  else {
    // Today's date is read per request, not baked into the prerendered shell.
    await io();
    period = await liveComps(utcDay(new Date()));
  }

  return (
    <div className="space-y-8">
      <PeriodPicker months={months} current={month} />
      {!period || period.results.sides === 0 ? (
        <p className="rounded border border-dashed border-border p-6 text-sm text-muted">
          Nothing here yet: the daily job has not read enough days of killmails.
        </p>
      ) : (
        <Results from={period.from} to={period.to} results={period.results} live={!month} />
      )}
      <Caveats />
    </div>
  );
}

function PeriodPicker({ months, current }: { months: string[]; current: string | null }) {
  const pill = (active: boolean) =>
    `rounded border px-3 py-1 text-sm ${active ? "border-accent text-foreground" : "border-border text-muted hover:text-foreground"}`;
  return (
    <nav aria-label="Period" className="flex flex-wrap gap-2">
      <Link href={PATH} scroll={false} aria-current={current === null ? "page" : undefined} className={pill(current === null)}>
        Last {LIVE_DAYS} days
      </Link>
      {months.map((month) => (
        <Link key={month} href={`${PATH}?month=${month}`} scroll={false} aria-current={current === month ? "page" : undefined} className={pill(current === month)}>
          {monthLabel(month)}
        </Link>
      ))}
    </nav>
  );
}

async function Results({ from, to, results, live }: { from: string; to: string; results: CompResults; live: boolean }) {
  const names = await hullNames(results);
  return (
    <>
      <p className="max-w-3xl text-sm text-muted">
        {live ? `${dayLabel(from)} to ${dayLabel(to)}` : monthLabel(from)}: {plural(results.sides, "fair fight")} by gangs of 3 to 7 pilots
        {results.overCap > 0 && <>, after leaving out {plural(results.overCap, "side")} that flew a hull whose typical fit costs over 1B</>}.
      </p>
      <GrowthPath results={results} />
      <MixesBySize results={results} />
      <HullsByRole results={results} names={names} />
    </>
  );
}

/** What a step of the growth path adds to the step before: "+1 DPS", or the whole mix after a swap. */
function added(previous: Mix | null, step: GrowthStep): string {
  if (!previous) return "Core";
  if (step.swap) return "Swap";
  return ROLES.flatMap((role, i) => (step.mix[i] > previous[i] ? [`+${step.mix[i] - previous[i]} ${ROLE_LABEL[role]}`] : [])).join(", ");
}

function statOf(results: CompResults, step: GrowthStep): MixStat | undefined {
  return results.sizes.find((size) => size.pilots === step.pilots)?.mixes.find((stat) => stat.mix.join() === step.mix.join());
}

function GrowthPath({ results }: { results: CompResults }) {
  if (results.growth.length === 0) return null;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold">Growth path</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Start with the best 3-pilot mix, then add one pilot at a time: at each size, the best mix that keeps the one before. Where none
          has {MIN_FIGHTS} fights, it swaps to that size&apos;s best mix.
        </p>
      </div>
      <ol className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {results.growth.map((step, i) => {
          const stat = statOf(results, step);
          const change = added(i === 0 ? null : results.growth[i - 1].mix, step);
          return (
            <li key={step.pilots} className="space-y-2 rounded border border-border bg-surface p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-medium">{step.pilots} pilots</span>
                <span className={`rounded border px-1.5 text-xs ${step.swap ? "border-amber-500 text-amber-500" : "border-accent text-accent"}`}>{change}</span>
              </div>
              <MixRoles mix={step.mix} />
              {stat && <WinRate stat={stat} />}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** A mix as one line per role. */
function MixRoles({ mix }: { mix: Mix }) {
  return (
    <ul className="text-sm">
      {ROLES.map((role, i) =>
        mix[i] ? (
          <li key={role}>
            <span className="inline-block w-5 text-right font-mono">{mix[i]}</span> {ROLE_LABEL[role]}
          </li>
        ) : null,
      )}
    </ul>
  );
}

function LowSample({ fights }: { fights: number }) {
  if (fights >= SOLID_FIGHTS) return null;
  return (
    <span className="rounded border border-border px-1 text-xs text-muted" title={`Fewer than ${SOLID_FIGHTS} fights: the win rate can be well off`}>
      low sample
    </span>
  );
}

function WinRate({ stat }: { stat: { wins: number; fights: number; low: number } }) {
  return (
    <p className="text-xs text-muted" title={`Wins ${stat.wins} of ${stat.fights}; at least ${percent(stat.low, 1)} with 95% confidence, which is what it ranks by`}>
      <span className="text-sm font-medium text-foreground">{percent(stat.wins, stat.fights)}</span> won of {plural(stat.fights, "fight")}{" "}
      <LowSample fights={stat.fights} />
    </p>
  );
}

function MixesBySize({ results }: { results: CompResults }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold">Mixes by gang size</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Every mix with at least {MIN_FIGHTS} fair fights, ranked by the low end of its win rate&apos;s 95% range, so a mix with few fights
          has to win clearly more to rank above one with many. ISK efficiency is destroyed ÷ (destroyed + lost).
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {results.sizes.map((size) => (
          <div key={size.pilots} className="rounded border border-border bg-surface">
            <h3 className="flex items-baseline gap-2 border-b border-border px-4 py-2">
              <span className="font-medium">{size.pilots} pilots</span>
              <span className="text-xs text-muted">{plural(size.sides, "fair fight")}</span>
            </h3>
            {size.mixes.length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted">No mix has {MIN_FIGHTS} fights yet.</p>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-muted">
                  <tr>
                    <th className="px-4 py-1.5 text-left font-normal">Mix</th>
                    <th className="px-2 py-1.5 text-right font-normal">Won</th>
                    <th className="px-2 py-1.5 text-right font-normal">Fights</th>
                    <th className="px-4 py-1.5 text-right font-normal" title="ISK destroyed ÷ (destroyed + lost)">
                      ISK eff.
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {size.mixes.map((stat) => (
                    <tr key={stat.mix.join()}>
                      <td className="px-4 py-1.5">
                        {mixLabel(stat.mix)} <LowSample fights={stat.fights} />
                      </td>
                      <td className="px-2 py-1.5 text-right" title={`At least ${percent(stat.low, 1)} with 95% confidence`}>
                        {percent(stat.wins, stat.fights)}
                      </td>
                      <td className="px-2 py-1.5 text-right text-muted">{stat.fights.toLocaleString("en")}</td>
                      <td className="px-4 py-1.5 text-right text-muted" title={`${formatIsk(stat.iskKilled)} destroyed, ${formatIsk(stat.iskLost)} lost`}>
                        {percent(stat.iskKilled, stat.iskKilled + stat.iskLost)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function HullsByRole({ results, names }: { results: CompResults; names: Record<number, string> }) {
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-xl font-semibold">Hulls by role</h2>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Hulls that flew in at least {MIN_FIGHTS} fair fights in gangs of 3 to 7, ranked like the mixes. Each fit is the loadout winning gangs
          lost most in that hull, under 1B and without officer, deadspace or abyssal modules. Open one to save a copy or send it to a
          character.
        </p>
      </div>
      <div className="grid gap-3 lg:grid-cols-2">
        {ROLES.map((role) => (
          <div key={role} className="rounded border border-border bg-surface">
            <div className="border-b border-border px-4 py-2">
              <h3 className="font-medium">{ROLE_LABEL[role]}</h3>
              <p className="text-xs text-muted">{ROLE_NOTE[role]}</p>
            </div>
            {results.hulls[role].length === 0 ? (
              <p className="px-4 py-3 text-sm text-muted">No hull has enough fights yet.</p>
            ) : (
              <>
                <HullList hulls={results.hulls[role].slice(0, HULLS_SHOWN)} names={names} />
                {results.hulls[role].length > HULLS_SHOWN && (
                  <details className="border-t border-border">
                    <summary className="cursor-pointer px-4 py-2 text-sm text-accent">Show all {results.hulls[role].length}</summary>
                    <HullList hulls={results.hulls[role].slice(HULLS_SHOWN)} names={names} />
                  </details>
                )}
              </>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function HullList({ hulls, names }: { hulls: HullStat[]; names: Record<number, string> }) {
  return (
    <ul className="divide-y divide-border">
      {hulls.map((hull) => {
        const name = names[hull.typeId] ?? `Type ${hull.typeId}`;
        return (
          <li key={hull.typeId} className="flex items-center gap-3 px-4 py-1.5">
            <Image src={typeIconUrl(hull.typeId, 64)} alt="" width={28} height={28} unoptimized className="rounded" />
            <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
            <span className="w-28 text-right text-xs text-muted" title={`Won ${hull.wins} of ${hull.fights}; at least ${percent(hull.low, 1)} with 95% confidence`}>
              <span className="text-foreground">{percent(hull.wins, hull.fights)}</span> of {hull.fights.toLocaleString("en")}
            </span>
            <span className="w-20 text-right text-xs">
              {hull.fit ? (
                <Link href={`${PATH}/fit/${hull.fit.killmailId}`} prefetch={false} className="text-accent hover:underline" title={`${formatIsk(hull.fit.value)} ISK; lost ${hull.fit.losses}× by winning gangs`}>
                  fit ×{hull.fit.losses}
                </Link>
              ) : (
                <span className="text-muted" title="Winning gangs lost no affordable fit in this hull">
                  no fit
                </span>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Caveats() {
  return (
    <section className="max-w-3xl space-y-2 rounded border border-border p-4 text-sm text-muted">
      <h2 className="font-medium text-foreground">How to read this</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          Read from every killmail on zKillboard outside highsec. Kills in one system within 15 minutes are a fight; groups shooting the same
          targets are a side. A side wins when it destroyed more ISK than it lost, and a fight counts only if the enemy had at least half as
          many pilots, and at least 2.
        </li>
        <li>
          Logi is undercounted: logi pilots rarely land on a killmail unless they die. Gang size is too: a pilot who never landed on a killmail
          is not counted.
        </li>
        <li>
          Correlation, not cause: tackle gets on killmails more easily when its side is winning, which can flatter tackle-heavy mixes.
        </li>
        <li>
          Fits come from losses only, so comps that rarely lose ships show fewer of them. ISK values use EVE&apos;s average prices and can differ
          from zKillboard&apos;s.
        </li>
      </ul>
    </section>
  );
}
