import type { NextResponse } from "next/server";
import { denialResponse, requireModuleAccess, type Viewer } from "@/lib/authz";
import { fail, ok, validationFailed } from "@/lib/api/response";
import { prisma } from "@/lib/db";
import { logUnexpected, logger } from "@/lib/logger";
import { BAS_MODULE_KEY } from "./constants";

/**
 * The wrapper every BAS route uses, modelled on
 * lib/modules/change-orders/mail/route-helpers.ts.
 *
 * Because the wrapper is what calls requireModuleAccess, a route cannot be
 * written without the grant check. Handlers below this point must never call
 * requireModuleAccess themselves - if a handler needs the viewer it is handed
 * one, and if it is not wrapped it has no viewer at all.
 */
export type ParsedInput<T> =
  | { ok: true; data: T }
  | { ok: false; message?: string };

/**
 * Why the platform can be "connected" to Postgres and still have no BAS data.
 *
 * The bas_* tables arrive in a migration (add_bas_tables), and a database that
 * has the platform's own tables but not that migration is a real state - a fresh
 * environment where `migrate deploy` has not run, or a restore from a backup
 * predating B1. Prisma would answer with a raw `relation "bas_points" does not
 * exist`, once per panel. This turns it into one honest answer.
 *
 * `unreachable` is the database itself failing, which is not specific to BAS but
 * reaches the caller through the same door.
 */
type BasAvailability =
  | { available: true }
  | {
      available: false;
      reason: "schema_missing" | "unreachable";
      /** Server-side diagnostics. Never serialised into a response. */
      detail: string;
    };

/**
 * Deliberately not cached.
 *
 * `to_regclass` is a catalog lookup, not a table scan, so the cost is one cheap
 * round trip. Caching the answer would mean a database that gained the migration
 * five minutes ago still reported it missing until the process restarted, and
 * would make this branch untestable without dropping a table.
 */
export async function basDataAvailability(): Promise<BasAvailability> {
  try {
    // bas_readings stands in for the whole schema: it is the last table the
    // migration creates and the one every screen ultimately joins to.
    const rows = await prisma.$queryRaw<
      Array<{ present: boolean }>
    >`SELECT to_regclass('public.bas_readings') IS NOT NULL AS present`;

    if (rows[0]?.present !== true) {
      return {
        available: false,
        reason: "schema_missing",
        detail:
          "public.bas_readings does not exist. The add_bas_tables migration " +
          "has not been applied to this database.",
      };
    }

    return { available: true };
  } catch (error) {
    return {
      available: false,
      reason: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** One non-technical string for both reasons. Neither is the caller's fault. */
const UNAVAILABLE_MESSAGE =
  "Building automation data is not available right now. Contact IT.";

/**
 * The order of the three steps is deliberate, and is the same order withMailbox
 * uses.
 *
 *   1. Authorization. An unauthenticated caller learns nothing else, including
 *      what a valid body would look like. A caller without the grant gets 404,
 *      not 403 - the platform does not confirm that a module exists to someone
 *      who cannot use it.
 *   2. Validation. A malformed request is malformed whether or not the BAS
 *      tables happen to be present, so it is answered honestly.
 *   3. Availability. Only then is "there is no BAS data here" the answer.
 */
export async function withBas<T = undefined>(
  route: string,
  handler: (viewer: Viewer, input: T) => Promise<NextResponse>,
  parse?: () => Promise<ParsedInput<T>>,
): Promise<NextResponse> {
  const access = await requireModuleAccess(BAS_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  let input = undefined as T;
  if (parse !== undefined) {
    const parsed = await parse();
    if (!parsed.ok) return validationFailed(parsed.message);
    input = parsed.data;
  }

  const availability = await basDataAvailability();
  if (!availability.available) {
    // The reason is named in the log and not in the response: an operator needs
    // to know which of the two it is, a browser does not.
    logger.error("bas.unavailable", {
      route,
      employeeId: access.viewer.id,
      moduleKey: BAS_MODULE_KEY,
      outcome: availability.reason,
      reason: availability.detail,
    });

    return fail(500, "bas_unavailable", UNAVAILABLE_MESSAGE);
  }

  try {
    return await handler(access.viewer, input);
  } catch (error) {
    logUnexpected("bas.route_failed", error, { route });
    return fail(500, "server_error", "Something went wrong. Try again.");
  }
}

export { ok };
