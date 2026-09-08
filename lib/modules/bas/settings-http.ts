import type { NextResponse } from "next/server";
import { fail } from "@/lib/api/response";
import { BasError, type BasErrorCode } from "./errors";
import { CredentialError } from "./credentials";

type SettingsErrorCode = Extract<
  BasErrorCode,
  | "project_not_found"
  | "building_not_found"
  | "org_not_found"
  | "name_taken"
  | "project_has_buildings"
  | "building_has_stations"
  | "invalid_timezone"
  | "station_not_found"
  | "station_cycle"
  | "station_has_points"
>;

/**
 * The only place a settings failure becomes a status code (B7.3).
 *
 * One table, so the four routes cannot disagree about what a name collision is.
 * A total record over the codes it handles, so adding a code without deciding
 * its status stops the build rather than defaulting to 500.
 *
 * 404 for anything not found, matching the module guard: a project this
 * employee may not see must not be distinguishable from one that is not there.
 * 409 for the two "you cannot do that yet" refusals - the request was
 * well-formed and the conflict is with the world rather than with the input.
 *
 * 422 for the timezone, which IS bad input, and 422 rather than 400 because
 * docs/07 lists exactly five statuses and 400 is not one of them. A zone that
 * fails the shape check in Zod and one that fails the pg_timezone_names check
 * in the service are the same class of mistake, and the caller should not have
 * to tell which half rejected it from the status.
 */
const STATUS: Record<SettingsErrorCode, number> = {
  project_not_found: 404,
  building_not_found: 404,
  org_not_found: 404,
  name_taken: 409,
  project_has_buildings: 409,
  building_has_stations: 409,
  invalid_timezone: 422,
  station_not_found: 404,
  // A well-formed request that the world refuses, like the other two 409s.
  station_cycle: 409,
  station_has_points: 409,
};

function isSettingsError(code: BasErrorCode): code is SettingsErrorCode {
  return Object.prototype.hasOwnProperty.call(STATUS, code);
}

/**
 * Runs a settings mutation and maps its refusal.
 *
 * Anything that is NOT one of these codes is rethrown, so an unexpected failure
 * still reaches withBasSettings and is logged as one rather than being
 * flattened into a tidy 400 that hides it.
 */
export async function settingsResult<T>(
  run: () => Promise<T>,
  respond: (value: T) => NextResponse,
): Promise<NextResponse> {
  try {
    return respond(await run());
  } catch (error) {
    if (error instanceof BasError && isSettingsError(error.code)) {
      return fail(STATUS[error.code], error.code, error.message);
    }

    /**
     * A missing or malformed BAS_CREDENTIAL_KEY. 500, because it is the
     * server that is not configured and not the request that is wrong - the
     * same shape as `bas_unavailable` for a database without the BAS tables.
     *
     * The message NAMES THE VARIABLE, deliberately. readGraphEnv already sets
     * that precedent: "variable names are not secrets, and naming them is the
     * difference between a five-minute fix and an afternoon of guessing." The
     * person who sees this is a module admin who will forward it to IT.
     *
     * CredentialError's message comes from a closed table keyed by code - it
     * cannot contain a password, a ciphertext or a key, because there is no
     * constructor that accepts arbitrary text.
     */
    if (error instanceof CredentialError) {
      return fail(500, error.code, error.message);
    }

    throw error;
  }
}
