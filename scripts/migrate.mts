// Applies drizzle/ migrations to DATABASE_URL. Run: pnpm db:migrate
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL is not set (copy .env.example to .env.local)");
  process.exit(1);
}
const pool = new Pool({ connectionString, max: 1 });
await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
await pool.end();
console.log("migrations applied");
