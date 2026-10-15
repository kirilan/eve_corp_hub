import { inject } from "vitest";

process.env.DATABASE_URL = inject("databaseUrl");
process.env.DATABASE_POOL_MAX = "1";
process.env.APP_URL = "http://localhost:3000";
process.env.EVE_CLIENT_ID = "test-client";
process.env.EVE_CLIENT_SECRET = "test-secret";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.ESI_CONTACT = "tests";
