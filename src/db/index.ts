import "server-only";
import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { strictSsl } from "./connection-string";
import * as schema from "./schema";

function connect() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  const pool = new Pool({
    connectionString: strictSsl(connectionString),
    // Local pglite-server multiplexes one real connection, so dev runs with 1 to keep each
    // transaction on its own; Neon's pooled endpoint is happy with more.
    max: Number(process.env.DATABASE_POOL_MAX ?? 5),
    idleTimeoutMillis: 5_000,
  });
  // Lets Vercel Fluid compute close idle clients before a function instance is suspended.
  attachDatabasePool(pool);
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof connect>;
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// Reused across hot reloads in dev, and across invocations sharing a warm instance in production.
const globalForDb = globalThis as unknown as { db?: Db };

/**
 * Connects on first use, not at import: `next build` imports every route while collecting page
 * data, and must not need a database to do that.
 */
export const db = new Proxy({} as Db, {
  get(_, property) {
    const real = (globalForDb.db ??= connect());
    const value = Reflect.get(real, property, real);
    return typeof value === "function" ? value.bind(real) : value;
  },
});
