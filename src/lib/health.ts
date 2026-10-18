import "server-only";
import { arrayContains, sql } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { db } from "@/db";
import { auditLog, characters, doctrines, eveTypes, fittings, sessions, users, walletEntries, walletSyncs } from "@/db/schema";
import { env } from "@/lib/env";
import { esi } from "@/lib/eve/esi";
import { FEATURE_SCOPES } from "@/lib/eve/sso";
import journal from "../../drizzle/meta/_journal.json";

/**
 * Figures for the super users' health panel: cheap counts and two round trips (database, ESI),
 * read when the panel is opened. Each probe catches its own failure, so one dead dependency
 * shows as failing instead of taking the panel down with it.
 */

const ESI_TIMEOUT_MS = 5_000;

type Probe<T> = ({ ok: true; latencyMs: number } & T) | { ok: false; error: string };

async function probe<T>(run: () => Promise<T>): Promise<Probe<T>> {
  const start = performance.now();
  try {
    const value = await run();
    return { ok: true, latencyMs: Math.round(performance.now() - start), ...value };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`no answer within ${ms / 1000} s`)), ms))]);
}

type EsiStatus = { players: number; server_version: string; start_time: string; vip?: boolean };

const tracking = arrayContains(characters.scopes, [...FEATURE_SCOPES.wallet]);
const daysAgo = (days: number) => sql`now() - make_interval(days => ${days})`;
const count = (from: PgTable, where = sql`true`) => sql`(SELECT count(*)::int FROM ${from} WHERE ${where})`;

async function counts() {
  const { rows } = await db.execute<Record<string, number>>(sql`
    SELECT
      ${count(users)} AS profiles,
      ${count(users, sql`${users.createdAt} > ${daysAgo(7)}`)} AS "newProfiles",
      (SELECT count(DISTINCT ${characters.userId})::int FROM ${characters} WHERE ${characters.lastLoginAt} > ${daysAgo(7)}) AS "activeProfiles",
      ${count(characters)} AS characters,
      ${count(characters, sql`${characters.tokenError} IS NOT NULL`)} AS "tokenErrors",
      ${count(sessions, sql`${sessions.expiresAt} > now()`)} AS sessions,
      ${count(characters, tracking)} AS tracking,
      (SELECT count(*)::int FROM ${characters} JOIN ${walletSyncs} ON ${walletSyncs.characterId} = ${characters.id}
        WHERE ${tracking} AND ${walletSyncs.syncedAt} > now() - interval '26 hours') AS "syncedToday",
      (SELECT count(*)::int FROM ${characters} JOIN ${walletSyncs} ON ${walletSyncs.characterId} = ${characters.id}
        WHERE ${tracking} AND ${walletSyncs.error} IS NOT NULL) AS failing,
      ${count(walletEntries)} AS "journalLines",
      ${count(fittings)} AS fits,
      ${count(fittings, sql`${fittings.visibility} = 'public'`)} AS "publicFits",
      ${count(doctrines)} AS doctrines,
      ${count(auditLog, sql`${auditLog.at} > ${daysAgo(7)}`)} AS "auditWeek",
      ${count(eveTypes)} AS "cachedTypes"
  `);
  return rows[0];
}

/** The distinct reasons tracked characters' wallet syncs are failing, most common first. */
async function syncErrors() {
  const { rows } = await db.execute<{ error: string; characters: number }>(sql`
    SELECT ${walletSyncs.error} AS error, count(*)::int AS characters
    FROM ${characters} JOIN ${walletSyncs} ON ${walletSyncs.characterId} = ${characters.id}
    WHERE ${tracking} AND ${walletSyncs.error} IS NOT NULL
    GROUP BY 1 ORDER BY 2 DESC LIMIT 5
  `);
  return rows;
}

export async function systemHealth() {
  const [database, esiStatus] = await Promise.all([
    probe(async () => {
      // The timed part is this round trip; the size and migration count ride along.
      const { rows } = await db.execute<{ size: number; migrations: number }>(sql`
        SELECT pg_database_size(current_database())::float8 AS size,
               (SELECT count(*)::int FROM drizzle.__drizzle_migrations) AS migrations
      `);
      return { sizeBytes: rows[0].size, migrationsApplied: rows[0].migrations };
    }),
    probe(async () => {
      const status = await withTimeout(esi<EsiStatus>("/status"), ESI_TIMEOUT_MS);
      return { players: status.players, serverVersion: status.server_version, startTime: new Date(status.start_time), vip: status.vip === true };
    }),
  ]);
  const [figures, errors] = await Promise.all([counts(), syncErrors()]);
  return {
    deployment: {
      environment: process.env.VERCEL_ENV ?? "local",
      commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? null,
      commitMessage: process.env.VERCEL_GIT_COMMIT_MESSAGE?.split("\n")[0] ?? null,
      region: process.env.VERCEL_REGION ?? null,
      node: process.version,
    },
    database,
    migrationsInRepo: journal.entries.length,
    esi: esiStatus,
    config: {
      cronSecret: env().CRON_SECRET !== undefined,
      esiContact: env().ESI_CONTACT !== "unset",
    },
    figures,
    syncErrors: errors,
  };
}

export type SystemHealth = Awaited<ReturnType<typeof systemHealth>>;
