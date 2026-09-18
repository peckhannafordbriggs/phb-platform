import { isLocalDatabase, databaseHost } from "./local-only";

/**
 * Which database a Prisma CLI command is allowed to touch.
 *
 * prisma.config.ts calls resolveMigrateTarget() on every invocation and hands
 * Prisma whatever URL comes back. That is the whole mechanism: there is no flag
 * to remember and no shell to be in, because the CLI cannot reach a database
 * without going through this file.
 *
 * WHY THIS EXISTS. Locally, DATABASE_URL names the database the collector
 * writes `bas_readings` into - about 45,000 rows in September 2026, the oldest
 * from February 2024 and no longer on the JACE. `prisma migrate dev` used to
 * point at that database too, and while an applied migration was being edited
 * Prisma offered to reset it. Prisma asks first, but a prompt is a convention,
 * and this repository's rule is that a convention someone has to remember is
 * not a guard.
 *
 * THE SPLIT.
 *
 *   `migrate dev`, `migrate reset`, `db push`   -> MIGRATE_DEV_DATABASE_URL
 *   everything else                             -> DATABASE_URL
 *
 * The first group can drop tables or reset a database as part of doing its job.
 * The second group applies what is already written (`migrate deploy`), reads
 * (`migrate status`, `migrate diff`), or edits history (`migrate resolve`). None
 * of them destroys data on its own.
 *
 * THE GUARDS on the first group, in the order they run. Each refuses with a
 * message that names the fix. The first three need no connection.
 *
 *   1. MIGRATE_DEV_DATABASE_URL must be set. There is no fallback to
 *      DATABASE_URL - a fallback is exactly the accident being prevented.
 *   2. It must be loopback. Nobody runs `migrate dev` against Azure.
 *   3. It must not name the same server and database as DATABASE_URL or
 *      TEST_DATABASE_URL. Compared on host, port and database name, not on the
 *      raw string, so a trailing slash or a reordered query string cannot slip
 *      past it.
 *   4. The target must hold zero `bas_readings` rows. This is the one check
 *      that looks at the database rather than at configuration, and it is what
 *      catches a variable pointed at the wrong place: a copy of the live
 *      database, a restore into the wrong name. A database that does not exist
 *      yet passes - `migrate dev` creates it.
 *
 * Only `bas_readings` is checked. Everything else in the database is
 * reproducible: employees from sign-in, reference data from the seed. The
 * readings are the rows that exist nowhere else.
 *
 * Pure apart from the injected row counter, so the routing and every refusal
 * can be unit tested without spawning Prisma. countLiveRows() is the real
 * counter; the tests pass a stub.
 */

/** The commands that may rewrite or reset a database as part of their job. */
export const DEV_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "migrate dev",
  "migrate reset",
  "db push",
]);

/** The one table whose rows cannot be re-fetched from anywhere. */
export const LIVE_DATA_TABLE = "bas_readings";

/** Variables MIGRATE_DEV_DATABASE_URL must not coincide with. */
export const PROTECTED_URL_VARIABLES = ["DATABASE_URL", "TEST_DATABASE_URL"] as const;

/**
 * Global flags that take their value as the NEXT token rather than as
 * `--flag=value`, and can therefore appear before the command.
 */
const FLAGS_WITH_SEPARATE_VALUE = new Set(["--config", "--schema"]);

export type TargetSource = "MIGRATE_DEV_DATABASE_URL" | "DATABASE_URL";

export interface ResolvedTarget {
  /** What prisma.config.ts hands to Prisma. Empty when the variable is unset. */
  url: string;
  source: TargetSource;
  /** `migrate dev`, `migrate deploy`, `generate`, ... or null for bare `prisma`. */
  command: string | null;
}

/**
 * A refusal. The message is complete on its own - diagnosis first, then the fix
 * - because the Prisma CLI prints it and exits, and there is no second line.
 * It never contains a connection string.
 */
export class MigrateTargetRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrateTargetRefused";
  }
}

/**
 * The Prisma command from the CLI's argv (everything after the executable and
 * the script). `["migrate", "dev", "--name", "x"]` -> "migrate dev";
 * `["--config", "p.ts", "migrate", "status"]` -> "migrate status";
 * `["generate"]` -> "generate"; `[]` -> null.
 */
export function prismaCommand(argv: readonly string[]): string | null {
  const words: string[] = [];

  for (let i = 0; i < argv.length && words.length < 2; i += 1) {
    const token = argv[i];
    if (token === undefined) break;
    if (token.startsWith("-")) {
      if (FLAGS_WITH_SEPARATE_VALUE.has(token)) i += 1;
      continue;
    }
    words.push(token);
  }

  return words.length === 0 ? null : words.join(" ");
}

export function isDevOnlyCommand(command: string | null): boolean {
  return command !== null && DEV_ONLY_COMMANDS.has(command);
}

export interface TargetIdentity {
  host: string;
  port: string;
  database: string;
}

/**
 * Host, port and database name - and nothing else, because a connection string
 * carries a password. Null when the value is missing or not a URL. The port
 * defaults to PostgreSQL's, so `localhost/x` and `localhost:5432/x` are the
 * same place.
 */
export function targetIdentity(connectionString: string | undefined | null): TargetIdentity | null {
  const host = databaseHost(connectionString);
  if (host === null || connectionString === undefined || connectionString === null) return null;

  try {
    const url = new URL(connectionString);
    const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (database.length === 0) return null;
    return { host, port: url.port.length > 0 ? url.port : "5432", database };
  } catch {
    return null;
  }
}

/** `localhost:5432/phb_platform` - safe to print. */
export function describeTarget(connectionString: string | undefined | null): string {
  const id = targetIdentity(connectionString);
  return id === null ? "(unreadable connection string)" : `${id.host}:${id.port}/${id.database}`;
}

/** True when both parse and name the same server and database. */
export function isSameDatabase(
  a: string | undefined | null,
  b: string | undefined | null,
): boolean {
  const left = targetIdentity(a);
  const right = targetIdentity(b);
  if (left === null || right === null) return false;
  return left.host === right.host && left.port === right.port && left.database === right.database;
}

/**
 * Rows in LIVE_DATA_TABLE at the target, or null when the database does not
 * exist yet. Throws when it cannot connect for any other reason - the guard
 * fails closed rather than assuming an unreachable database is empty.
 */
export type LiveRowCounter = (connectionString: string) => Promise<number | null>;

/** PostgreSQL SQLSTATE for "database does not exist". */
const INVALID_CATALOG_NAME = "3D000";

export const countLiveRows: LiveRowCounter = async (connectionString) => {
  // Imported here rather than at the top so that `prisma generate` - which runs
  // on every `npm ci`, including the Docker deps stage - never loads a database
  // driver it does not need.
  const { Client } = await import("pg");
  const client = new Client({ connectionString });

  try {
    await client.connect();
  } catch (error) {
    if ((error as { code?: string }).code === INVALID_CATALOG_NAME) return null;
    throw new MigrateTargetRefused(
      `Could not connect to ${describeTarget(connectionString)} to check whether it ` +
        `holds ${LIVE_DATA_TABLE} rows, so the command is refused rather than assumed safe.\n` +
        `  ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const present = await client.query<{ present: boolean }>(
      `SELECT to_regclass('public.${LIVE_DATA_TABLE}') IS NOT NULL AS present`,
    );
    if (present.rows[0]?.present !== true) return 0;

    const count = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${LIVE_DATA_TABLE}`);
    return Number(count.rows[0]?.n ?? 0);
  } finally {
    await client.end();
  }
};

export interface ResolveInput {
  /** process.argv.slice(2) inside the Prisma CLI. */
  argv: readonly string[];
  env: Readonly<Record<string, string | undefined>>;
  countLiveRows: LiveRowCounter;
}

function refuse(command: string, why: string, fix: string): never {
  throw new MigrateTargetRefused(
    `\n=== \`prisma ${command}\` refused ===\n\n${why}\n\n${fix}\n\n` +
      `\`migrate dev\`, \`migrate reset\` and \`db push\` can drop tables or reset a ` +
      `database, so they run only against MIGRATE_DEV_DATABASE_URL - a database ` +
      `of their own that holds no ${LIVE_DATA_TABLE}. Locally, DATABASE_URL is where ` +
      `the collector writes readings that no longer exist on the station. Apply a ` +
      `finished migration there with \`prisma migrate deploy\`.\n` +
      `See runbook.md, "Which command touches which database".\n`,
  );
}

/**
 * Decides the URL for this invocation. Throws MigrateTargetRefused for a
 * dev-only command whose target fails any guard; never throws for anything
 * else, because `prisma generate` has to work with no database at all.
 */
export async function resolveMigrateTarget(input: ResolveInput): Promise<ResolvedTarget> {
  const command = prismaCommand(input.argv);

  if (!isDevOnlyCommand(command)) {
    return { url: input.env.DATABASE_URL?.trim() ?? "", source: "DATABASE_URL", command };
  }

  // From here on `command` is one of DEV_ONLY_COMMANDS, so it is a string.
  const name = command as string;
  const devUrl = input.env.MIGRATE_DEV_DATABASE_URL?.trim();

  if (devUrl === undefined || devUrl.length === 0) {
    refuse(
      name,
      `MIGRATE_DEV_DATABASE_URL is not set. This command does not fall back to DATABASE_URL.`,
      `Fix: create an empty database for it and add the line to .env.local:\n\n` +
        `  createdb phb_platform_dev\n` +
        `  MIGRATE_DEV_DATABASE_URL="postgresql://USER:PASSWORD@localhost:5432/phb_platform_dev"`,
    );
  }

  if (!isLocalDatabase(devUrl)) {
    const host = databaseHost(devUrl);
    refuse(
      name,
      `MIGRATE_DEV_DATABASE_URL points at ${host === null ? "no readable host" : `"${host}"`}, not at localhost.`,
      `Fix: point it at a database on this machine. A deployed database only ever ` +
        `receives \`prisma migrate deploy\`.`,
    );
  }

  for (const variable of PROTECTED_URL_VARIABLES) {
    if (isSameDatabase(devUrl, input.env[variable])) {
      refuse(
        name,
        `MIGRATE_DEV_DATABASE_URL and ${variable} both name ${describeTarget(devUrl)}.`,
        `Fix: give the development database its own name, for example phb_platform_dev, ` +
          `and point MIGRATE_DEV_DATABASE_URL at that.`,
      );
    }
  }

  const rows = await input.countLiveRows(devUrl);
  if (rows !== null && rows > 0) {
    refuse(
      name,
      `${describeTarget(devUrl)} holds ${rows.toLocaleString("en-US")} ${LIVE_DATA_TABLE} ` +
        `row${rows === 1 ? "" : "s"}. That is live building data, not a development database.`,
      `Fix: point MIGRATE_DEV_DATABASE_URL at an empty database. If this is the ` +
        `database the collector writes to, it must never be the target of this command.`,
    );
  }

  return { url: devUrl, source: "MIGRATE_DEV_DATABASE_URL", command };
}
