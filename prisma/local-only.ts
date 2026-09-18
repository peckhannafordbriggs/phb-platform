/**
 * The guard that keeps development-only scripts pointed at a development
 * database.
 *
 * Its own module, free of side effects, so the predicate can be unit tested.
 * prisma/seed-dev.ts runs its work at import time, so a test that imported it to
 * reach this logic would execute the thing it is testing.
 *
 * Deliberately NOT applied in scripts/db.ts. That is shared with prisma/seed.ts,
 * which is idempotent, safe, and *meant* to run against production - it is how
 * the bootstrap admins get created.
 */

/**
 * Hostnames that can only mean this machine.
 *
 * `::1` is stored unbracketed. For a non-special scheme like postgresql:, Node's
 * URL keeps the brackets on an IPv6 host - `hostname` is "[::1]", not "::1" -
 * and it normalises the long form, so `[0:0:0:0:0:0:0:1]` also arrives as
 * "[::1]". databaseHost strips the brackets before comparing.
 */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "::1"]);

/** The whole 127.0.0.0/8 block is loopback, not just 127.0.0.1. */
const LOOPBACK_IPV4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Returns the hostname, or null if the value is missing or not a URL.
 *
 * Only ever the hostname. A connection string contains a password, so nothing
 * here returns, logs, or throws the whole thing.
 */
export function databaseHost(connectionString: string | undefined | null): string | null {
  if (connectionString === undefined || connectionString === null) return null;
  if (connectionString.trim().length === 0) return null;

  try {
    const host = new URL(connectionString).hostname.toLowerCase();
    if (host.length === 0) return null;

    // "[::1]" -> "::1". Comparing the bracketed form would work too, but the
    // brackets are URL syntax rather than part of the address, and an error
    // message reads better without them.
    const unbracketed =
      host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;

    return unbracketed.length > 0 ? unbracketed : null;
  } catch {
    return null;
  }
}

/**
 * Fails closed: anything unparseable, absent, or not loopback is "not local".
 */
export function isLocalDatabase(connectionString: string | undefined | null): boolean {
  const host = databaseHost(connectionString);
  if (host === null) return false;

  return LOOPBACK_HOSTNAMES.has(host) || LOOPBACK_IPV4.test(host);
}

/**
 * Throws unless the connection string points at this machine.
 *
 * There is no override environment variable, on purpose. An escape hatch is a
 * thing that gets set once in a shell and then forgotten, and the whole point of
 * this guard is the case where somebody has a production URL in their
 * environment without noticing. Pointing a development script at a remote
 * database should require editing code and thinking about it.
 */
export function assertLocalDatabase(
  connectionString: string | undefined | null,
  scriptName: string,
): void {
  if (isLocalDatabase(connectionString)) return;

  const host = databaseHost(connectionString);

  throw new Error(
    `${scriptName} refuses to run: DATABASE_URL points at ` +
      `${host === null ? "no readable host" : `"${host}"`}, not at localhost.\n\n` +
      `This script creates fake employees. Against a real database that is not a ` +
      `mess to clean up: audit_events is append-only and its foreign keys are ` +
      `ON DELETE SET NULL, so a fake row cannot be deleted at all once it has any ` +
      `audit history.\n\n` +
      `Point DATABASE_URL at your local Postgres and run it again.`,
  );
}
