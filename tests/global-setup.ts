import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** A throwaway in-memory Postgres (PGlite) behind a real wire-protocol socket, migrated once per run. */
export default async function setup(project: TestProject) {
  const pglite = await PGlite.create();
  const port = 54400 + Math.floor(Math.random() * 500);
  const server = new PGLiteSocketServer({ db: pglite, port, host: "127.0.0.1" });
  await server.start();
  const databaseUrl = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  await pool.end();

  project.provide("databaseUrl", databaseUrl);
  return async () => {
    await server.stop();
    await pglite.close();
  };
}
