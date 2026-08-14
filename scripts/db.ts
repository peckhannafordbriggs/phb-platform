import path from "node:path";
import { config as loadEnv } from "dotenv";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../lib/generated/prisma/client";

/**
 * A Prisma client for scripts (seeding, test setup).
 *
 * Deliberately separate from lib/db/client.ts: that one validates the full
 * application environment, including the Entra variables. Seeding a database
 * should not require an app registration to exist.
 */

loadEnv({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
loadEnv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

export function createDbClient(connectionString?: string): PrismaClient {
  const url = connectionString ?? process.env.DATABASE_URL;

  if (url === undefined || url.trim().length === 0) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.",
    );
  }

  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}
