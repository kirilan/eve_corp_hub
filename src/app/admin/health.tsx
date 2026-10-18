import { type CronJobStatus, cronStatus, describeSchedule, type RunState, runState } from "@/lib/cron";
import { type SystemHealth, systemHealth } from "@/lib/health";

type Status = "ok" | "warn" | "fail";

// Status never rides on colour alone: each badge has its icon and word.
const BADGE: Record<Status, { icon: string; label: string; className: string }> = {
  ok: { icon: "✓", label: "OK", className: "bg-emerald-500/15 text-emerald-300" },
  warn: { icon: "!", label: "Check", className: "bg-amber-500/15 text-amber-300" },
  fail: { icon: "✕", label: "Failing", className: "bg-red-500/15 text-red-300" },
};

const RUN: Record<RunState, { status: Status; label: string }> = {
  ok: { status: "ok", label: "Succeeded" },
  running: { status: "warn", label: "Running" },
  failed: { status: "fail", label: "Failed" },
  killed: { status: "fail", label: "Did not finish" },
};

function Badge({ status, label }: { status: Status; label?: string }) {
  const badge = BADGE[status];
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${badge.className}`}>
      <span aria-hidden>{badge.icon}</span>
      {label ?? badge.label}
    </span>
  );
}

function eveTime(date: Date): string {
  return `${date.toISOString().slice(0, 16).replace("T", " ")} EVE`;
}

function ago(date: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - date.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / (24 * 60))} days ago`;
}

function until(date: Date, now: Date): string {
  const minutes = Math.round((date.getTime() - now.getTime()) / 60_000);
  return minutes < 60 ? `in ${minutes} min` : `in ${Math.round(minutes / 60)} h`;
}

function bytes(value: number): string {
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

const number = (value: number) => value.toLocaleString("en-US");

/** What a run reported, in words: the wallet sync's { synced, remaining }, or any other result as key/value pairs. */
function summary(result: Record<string, unknown> | null): string {
  if (!result) return "";
  if (typeof result.synced === "number" && typeof result.remaining === "number") {
    return `${result.synced} character${result.synced === 1 ? "" : "s"} synced${result.remaining ? `, ${result.remaining} left for lack of time` : ""}`;
  }
  return Object.entries(result)
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(", ");
}

function Card({ title, status, children }: { title: string; status?: Status; children: React.ReactNode }) {
  return (
    <div className="space-y-2 rounded border border-border bg-surface p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-medium">{title}</h3>
        {status && <Badge status={status} />}
      </div>
      <dl className="space-y-1 text-sm">{children}</dl>
    </div>
  );
}

function Row({ label, children, status }: { label: string; children: React.ReactNode; status?: Status }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd className="flex items-center gap-1.5 text-right tabular-nums">
        {children}
        {status && status !== "ok" && <Badge status={status} />}
      </dd>
    </div>
  );
}

function Job({ job, now, production }: { job: CronJobStatus; now: Date; production: boolean }) {
  const last = job.runs[0];
  const lastState = last ? RUN[runState(last, now)] : null;
  const status: Status = job.overdue ? "fail" : (lastState?.status ?? (production ? "warn" : "ok"));
  return (
    <div className="space-y-3 rounded border border-border bg-surface p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="font-medium">{job.name}</h3>
        <code className="text-xs text-muted">{job.path}</code>
        <Badge status={status} label={job.overdue ? "Overdue" : (lastState?.label ?? "Never run")} />
      </div>
      <p className="text-sm text-muted">
        {describeSchedule(job.schedule)}
        {job.nextRun && <> · next {until(job.nextRun, now)}</>}
        {" · "}
        {job.lastSuccess ? `last success ${ago(job.lastSuccess, now)}` : "no successful run yet"}
        {job.overdue && " · the scheduler has not called it on time: check Cron Jobs in the Vercel project settings"}
      </p>
      {job.runs.length === 0 ? (
        <p className="text-sm text-muted">
          No runs recorded yet.{" "}
          {production ? "The first one comes at the next scheduled time." : "Vercel Cron only calls production deployments."}
        </p>
      ) : (
        // A list rather than a table: on a phone the details drop to their own line instead of a sliver of a column.
        <ul className="divide-y divide-border text-sm">
          {job.runs.map((run) => {
            const state = runState(run, now);
            return (
              <li key={run.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-1.5">
                <span className="font-mono text-xs">{eveTime(run.startedAt)}</span>
                <span className="w-16 text-right tabular-nums">
                  {run.finishedAt ? `${((run.finishedAt.getTime() - run.startedAt.getTime()) / 1000).toFixed(1)} s` : "–"}
                </span>
                <span className="w-32">
                  <Badge status={RUN[state].status} label={RUN[state].label} />
                </span>
                <span className="basis-full text-muted sm:basis-auto">
                  {run.error ??
                    (state === "killed"
                      ? "Stopped before it ended: timed out or crashed (see the function logs in Vercel)"
                      : summary(run.result))}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Figures({ health, now }: { health: SystemHealth; now: Date }) {
  const { deployment, database, esi, config, figures: f, syncErrors } = health;
  const migrationsBehind = database.ok && database.migrationsApplied < health.migrationsInRepo;
  const unsynced = f.tracking - f.syncedToday;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      <Card title="Deployment">
        <Row label="Environment">{deployment.environment}</Row>
        <Row label="Commit">
          {deployment.commit ? (
            <span title={deployment.commitMessage ?? undefined} className="font-mono text-xs">
              {deployment.commit}
            </span>
          ) : (
            "–"
          )}
        </Row>
        {deployment.commitMessage && <p className="truncate text-xs text-muted">{deployment.commitMessage}</p>}
        <Row label="Region">{deployment.region ?? "–"}</Row>
        <Row label="Node.js">{deployment.node}</Row>
      </Card>

      <Card title="Database" status={!database.ok ? "fail" : migrationsBehind ? "warn" : "ok"}>
        {database.ok ? (
          <>
            <Row label="Round trip">{database.latencyMs} ms</Row>
            <Row label="Size">{bytes(database.sizeBytes)}</Row>
            <Row label="Migrations" status={migrationsBehind ? "warn" : undefined}>
              {database.migrationsApplied} of {health.migrationsInRepo} applied
            </Row>
          </>
        ) : (
          <p className="text-sm text-red-300">{database.error}</p>
        )}
      </Card>

      <Card title="EVE ESI" status={!esi.ok ? "fail" : esi.vip ? "warn" : "ok"}>
        {esi.ok ? (
          <>
            <Row label="Round trip">{esi.latencyMs} ms</Row>
            <Row label="Players online">{number(esi.players)}</Row>
            <Row label="Server version">{esi.serverVersion}</Row>
            <Row label="Up since">{ago(esi.startTime, now)}</Row>
            {esi.vip && <p className="text-xs text-amber-300">Tranquility is in VIP mode: only developers can log in.</p>}
          </>
        ) : (
          <p className="text-sm text-red-300">{esi.error}</p>
        )}
      </Card>

      <Card title="Accounts">
        <Row label="Profiles">
          {number(f.profiles)}
          {f.newProfiles > 0 && <span className="text-muted"> (+{f.newProfiles} this week)</span>}
        </Row>
        <Row label="Signed in, last 7 days">{number(f.activeProfiles)}</Row>
        <Row label="Characters">{number(f.characters)}</Row>
        <Row label="Active sessions">{number(f.sessions)}</Row>
        <Row label="Lost SSO consent">{number(f.tokenErrors)}</Row>
      </Card>

      <Card title="Wallet tracking" status={f.failing > 0 || unsynced > 0 ? "warn" : "ok"}>
        <Row label="Tracked characters">{number(f.tracking)}</Row>
        <Row label="Synced in the last day" status={unsynced > 0 ? "warn" : undefined}>
          {number(f.syncedToday)} of {number(f.tracking)}
        </Row>
        <Row label="Last sync failed" status={f.failing > 0 ? "warn" : undefined}>
          {number(f.failing)}
        </Row>
        <Row label="Journal lines stored">{number(f.journalLines)}</Row>
        {syncErrors.length > 0 && (
          <ul className="space-y-0.5 pt-1 text-xs text-muted">
            {syncErrors.map((e) => (
              <li key={e.error}>
                {e.characters} × {e.error}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Content">
        <Row label="Fits">
          {number(f.fits)} <span className="text-muted">({number(f.publicFits)} public)</span>
        </Row>
        <Row label="Doctrines">{number(f.doctrines)}</Row>
        <Row label="Audit entries, last 7 days">{number(f.auditWeek)}</Row>
        <Row label="Item types cached">{number(f.cachedTypes)}</Row>
      </Card>

      <Card title="Configuration" status={config.cronSecret && config.esiContact ? "ok" : "warn"}>
        <Row label="CRON_SECRET" status={config.cronSecret ? undefined : "warn"}>
          {config.cronSecret ? "set" : "missing: cron calls are refused"}
        </Row>
        <Row label="ESI_CONTACT" status={config.esiContact ? undefined : "warn"}>
          {config.esiContact ? "set" : "unset: CCP asks for a contact"}
        </Row>
      </Card>
    </div>
  );
}

/** The super users' health panel on /admin: scheduled jobs first, then dependencies and site-wide counts. */
export async function HealthPanel() {
  const now = new Date();
  const [jobs, health] = await Promise.all([cronStatus(now), systemHealth()]);
  const production = health.deployment.environment === "production";
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-medium">System health</h2>
      <p className="text-sm text-muted">Read when this page loads; reload for fresh figures. Only super users see this section.</p>
      {jobs.map((job) => (
        <Job key={job.path} job={job} now={now} production={production} />
      ))}
      <Figures health={health} now={now} />
    </section>
  );
}
