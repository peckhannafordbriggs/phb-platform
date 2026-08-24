import { PrismaClient } from "@/lib/generated/prisma/client";
import { createPgAdapter } from "./adapter";

/**
 * Deliberately does not import lib/env.ts.
 *
 * The database needs one variable. Validating the whole application
 * environment here would make every database-backed test depend on an Entra app
 * registration existing, which has nothing to do with the database. Auth
 * configuration is validated where auth is used.
 */
function connectionString(): string {
  const url = process.env.DATABASE_URL?.trim();

  if (url === undefined || url.length === 0) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.",
    );
  }

  return url;
}

function createClient(): PrismaClient {
  return new PrismaClient({
    adapter: createPgAdapter(connectionString()),
    log: ["warn", "error"],
  });
}

// Next.js dev server reloads modules on every edit. Without this the process
// accumulates a connection pool per reload until Postgres refuses new clients.
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
