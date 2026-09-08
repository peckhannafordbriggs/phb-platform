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
 * 404 - not 403 - for a missing module grant, and for a module grant that does
 * not carry admin rights: do not confirm the existence of modules, or of a
 * module's settings, to a caller who cannot reach them. 403 for a non-admin,
 * because platform admin is not a module and its existence is not a secret.
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
    // Same 404 as a missing grant, for the same reason: a module's
    // administrative surface is not something the platform confirms the
    // existence of to someone who may not use it.
    case "not_module_admin":
    case "no_grant":
      return notFound();
  }
}
