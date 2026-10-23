/**
 * Date-only values (`YYYY-MM-DD`): verification, test, notice, due, documented
 * and transmittal dates. Postgres `date` columns arrive through Prisma as a Date
 * at midnight UTC, so they are formatted in UTC. Formatting one in a local zone
 * shows the day before, which the platform has been bitten by twice.
 */

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A `YYYY-MM-DD` string that names a real calendar day. */
export function isDateOnly(value: string): boolean {
  const m = DATE_ONLY.exec(value);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}

export function toDateOnly(value: Date): string;
export function toDateOnly(value: Date | null): string | null;
export function toDateOnly(value: Date | null): string | null {
  return value === null ? null : value.toISOString().slice(0, 10);
}

/** For writing. The caller has validated the string with `isDateOnly`. */
export function fromDateOnly(value: string): Date;
export function fromDateOnly(value: string | null): Date | null;
export function fromDateOnly(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00.000Z`);
}

/** Today in America/New_York, as `YYYY-MM-DD`. Business dates never use UTC. */
export function todayInNewYork(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(now);
}
