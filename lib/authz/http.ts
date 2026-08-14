import type { NextResponse } from "next/server";
import {
  forbidden,
  notFound,
  unauthenticated,
} from "@/lib/api/response";
import type { Denial } from "./guard";

/**
 * The only place a denial becomes a status code.
 *
 * 404 - not 403 - for a missing module grant: do not confirm the existence of
 * modules the caller cannot access. 403 for a non-admin, because admin is not a
 * module and its existence is not a secret.
 */
export function denialResponse(denial: Denial): NextResponse {
  switch (denial) {
    case "unauthenticated":
    case "session_expired":
    case "employee_inactive":
      return unauthenticated();
    case "profile_incomplete":
      return forbidden("Complete your profile to continue.");
    case "not_admin":
      return forbidden();
    case "no_grant":
      return notFound();
  }
}
