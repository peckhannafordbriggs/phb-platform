import { PrismaPg } from "@prisma/adapter-pg";

/**
 * The one place a PostgreSQL connection is configured. Every PrismaClient in the
 * repo - the application, the test suite, the scripts - is built from this.
 *
 * ---------------------------------------------------------------------------
 * `timezone=UTC` is a correctness fix, not a preference. Do not remove it.
 *
 * Measured on 24 August 2026 against phb_platform_test, whose server session
 * timezone was `America/New_York`:
 *
 *   JS `new Date()`                 2026-08-24T12:59:30.599Z
 *   written through Prisma, stored  2026-08-24 12:59:30.599-04   (+4 h)
 *   `SELECT now()` text             2026-08-24 08:59:30.809-04
 *   the same now(), parsed by Prisma 2026-08-24T08:59:30.809Z     (-4 h)
 *
 * Prisma's driver-adapter layer moves a `timestamptz` across the boundary as a
 * naive wall-clock string with the offset discarded. The session timezone then
 * supplies one. Writes gain the offset, reads lose it, and the two cancel - so a
 * value written and read back through Prisma is unchanged and nothing ever
 * complains. Everything else disagrees:
 *
 *   - any SQL that compares a Prisma-written timestamp against `now()`,
 *     `age()`, or another server-side clock is wrong by the session offset;
 *   - any timestamp Prisma hands to a browser is wrong by the session offset;
 *   - the error moves with DST, so it is 5 h for half the year.
 *
 * With the session pinned to UTC the discarded offset is `+00`, both directions
 * become exact, and the measurements above come back to the millisecond.
 *
 * This also makes every environment agree by construction. A developer laptop in
 * Ohio, CI in UTC and Azure Database for PostgreSQL would otherwise each apply a
 * different shift to the same code, which is the shape of bug that reproduces
 * nowhere.
 *
 * It changes only how this connection interprets and renders timestamps. Nothing
 * is stored differently: `timestamptz` is an absolute instant on disk in every
 * session. See docs/runbook.md, *Timestamps written through Prisma were four
 * hours out*.
 */
export function createPgAdapter(connectionString: string): PrismaPg {
  return new PrismaPg({
    connectionString,
    // libpq-style startup options, applied per connection in the pool.
    options: "-c timezone=UTC",
  });
}
