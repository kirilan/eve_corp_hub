// Applies drizzle/ migrations. Run: pnpm db:migrate (local), and automatically on Vercel production
// builds via `pnpm vercel-build` (--deploy), which skips preview builds: those share no schema
// decisions with production and must never migrate its database.
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { strictSsl } from "../src/db/connection-string";

const deploy = process.argv.includes("--deploy");
if (deploy && process.env.VERCEL_ENV !== "production") {
  console.log(`migrations: skipped (VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}; only production deploys migrate)`);
  process.exit(0);
}

// Neon's integration also provides a direct (unpooled) URL; schema changes are safer without PgBouncer in between.
const connectionString = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;
if (!connectionString) {
  if (deploy) {
    // A first deploy can happen before the database is connected; the site then reports the missing database at runtime.
    console.warn("migrations: WARNING - no DATABASE_URL; skipped. Connect the database, then redeploy.");
    process.exit(0);
  }
  console.error("DATABASE_URL is not set (copy .env.example to .env.local)");
  process.exit(1);
}
const pool = new Pool({ connectionString: strictSsl(connectionString), max: 1 });
await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
await pool.end();
console.log("migrations applied");
