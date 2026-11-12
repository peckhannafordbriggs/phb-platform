import type { NextResponse } from "next/server";
import { fail } from "@/lib/api/response";
import { BasError, type BasErrorCode } from "../errors";

type ReportsErrorCode = Extract<
  BasErrorCode,
  | "report_not_found"
  | "site_not_found"
  | "station_other_building"
  | "invalid_schedule"
  | "name_taken"
  | "report_not_ready"
  | "invalid_state"
  | "question_exists"
  | "library_question_not_found"
  | "library_question_disabled"
  | "personal_question_not_found"
  | "personal_question_not_owner"
  | "personal_question_in_use"
  | "owner_is_recipient"
  | "recipient_exists"
  | "recipient_not_found"
  | "external_unconfirmed"
  | "report_has_runs"
  | "run_not_found"
  | "run_in_flight"
  | "admin_required"
  | "owner_not_eligible"
  | "pdf_not_available"
  | "pdf_not_retryable"
>;

/**
 * The only place a Reports failure becomes a status code (Phase 1), on the
 * settings-http.ts pattern: one total record, so adding a code without
 * deciding its status stops the build rather than defaulting to 500.
 *
 * 404 for anything not found, which includes a report the viewer may not see:
 * the plan says "everything else 404 per module convention", and a 403 would
 * confirm that somebody else's report exists. 409 for a well-formed request
 * the world refuses - a question twice in one selection, the owner's
 * address, an external address not yet confirmed. 422 for input that is
 * wrong in a way the shape check could not see.
 */
const STATUS: Record<ReportsErrorCode, number> = {
  report_not_found: 404,
  site_not_found: 404,
  station_other_building: 409,
  invalid_schedule: 422,
  name_taken: 409,
  report_not_ready: 409,
  invalid_state: 409,
  question_exists: 409,
  library_question_not_found: 404,
  library_question_disabled: 409,
  personal_question_not_found: 404,
  personal_question_not_owner: 409,
  personal_question_in_use: 409,
  owner_is_recipient: 409,
  recipient_exists: 409,
  recipient_not_found: 404,
  external_unconfirmed: 409,
  report_has_runs: 409,
  run_not_found: 404,
  run_in_flight: 409,
  // The one 403 here: the report (or the Usage page) is visible to the
  // person, so 404 would be a lie, and what they lack is the admin flag, not
  // access. Transferring an owner and setting the safety ceiling.
  admin_required: 403,
  owner_not_eligible: 409,
  // The run is visible, so 404 would be a lie; the file is what is missing.
  pdf_not_available: 409,
  pdf_not_retryable: 409,
};

function isReportsError(code: BasErrorCode): code is ReportsErrorCode {
  return Object.prototype.hasOwnProperty.call(STATUS, code);
}

/**
 * Runs a Reports operation and maps its refusal. Anything that is not one of
 * these codes is rethrown, so an unexpected failure still reaches withBas and
 * is logged as one.
 */
export async function reportsResult<T>(
  run: () => Promise<T>,
  respond: (value: T) => NextResponse,
): Promise<NextResponse> {
  try {
    return respond(await run());
  } catch (error) {
    if (error instanceof BasError && isReportsError(error.code)) {
      return fail(STATUS[error.code], error.code, error.message);
    }
    throw error;
  }
}
