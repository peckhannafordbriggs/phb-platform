import path from "node:path";
import { config as loadEnv } from "dotenv";
import { defineConfig } from "prisma/config";
import { countLiveRows, resolveMigrateTarget } from "./prisma/migrate-target";

// Prisma 7 does not read .env files on its own. Next.js reads .env.local, so
// that is the one file a developer has to fill in - the CLI is pointed at the
// same place rather than a second copy that can drift. dotenv never overrides a
// variable that is already in the environment, so a value exported in the shell
// or set by CI wins over the file.
loadEnv({ path: path.resolve(process.cwd(), ".env.local"), quiet: true });
loadEnv({ path: path.resolve(process.cwd(), ".env"), quiet: true });

// Everything under ./prisma/ is copied into the Docker deps stage so that
// `prisma generate` can run from postinstall. Nothing else in the repository is
// there yet, so this file may import from ./prisma/ and from node_modules only
// - tests/migrate-target.test.ts asserts it.

/**
 * The default export is a promise, which the Prisma CLI awaits. It has to be:
 * deciding where `migrate dev` may point involves asking the database whether
 * it holds bas_readings, and that is the guard that catches a variable aimed at
 * the wrong place. prisma/migrate-target.ts explains the split and each check.
 */
export default (async () => {
  const target = await resolveMigrateTarget({
    argv: process.argv.slice(2),
    env: process.env,
    countLiveRows,
  });

  if (target.source === "MIGRATE_DEV_DATABASE_URL") {
    // `migrate reset`, and `migrate dev` when it creates or resets the database,
    // run the seed below as a child process - and prisma/seed.ts connects to
    // DATABASE_URL, not to Prisma's datasource. Redirecting it here keeps the
    // whole command on the development database. Without this line a reset of
    // the dev database would seed the live one.
    process.env.DATABASE_URL = target.url;
  }

  // One line per invocation that touches a database, naming which one and why,
  // so the answer to "which database did that just run against" is in the
  // terminal rather than in someone's memory. `generate` and the like stay quiet.
  if (target.command !== null && /^(migrate|db) /.test(target.command)) {
    const where = target.url.length > 0 ? describe(target.url) : "(no URL set)";
    console.error(`[prisma.config] ${target.command} -> ${where}  (${target.source})`);
  }

  return defineConfig({
    schema: path.join("prisma", "schema.prisma"),
    datasource: {
      url: target.url,
    },
    migrations: {
      path: path.join("prisma", "migrations"),
      seed: "tsx prisma/seed.ts",
    },
  });
})();

/** Host and database only. A connection string carries a password. */
function describe(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.host}${url.pathname}`;
  } catch {
    return "(unreadable connection string)";
  }
}
