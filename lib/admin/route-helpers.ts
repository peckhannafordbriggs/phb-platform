import type { NextResponse } from "next/server";
import { denialResponse, requireAdmin, type Viewer } from "@/lib/authz";
import { forbidden, notFound, serverError, validationFailed } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import type { AdminFailure } from "./service";

/**
 * Every /api/admin/* route independently verifies isPlatformAdmin. This wrapper
 * is how that stays true without each handler repeating it - and because it is
 * the wrapper that calls requireAdmin, a route cannot accidentally be written
 * without the check.
 */
export async function withAdmin(
  route: string,
  handler: (viewer: Viewer) => Promise<NextResponse>,
): Promise<NextResponse> {
  const access = await requireAdmin();
  if (!access.ok) return denialResponse(access.denial);

  try {
    return await handler(access.viewer);
  } catch (error) {
    logUnexpected("admin.route_failed", error, {
      route,
      employeeId: access.viewer.id,
    });
    return serverError();
  }
}

/**
 * Guardrail violations are 403: authenticated, admin, but this particular
 * action is not allowed - which is exactly what docs/07-conventions.md reserves
 * 403 for. A missing employee or module is 404.
 */
export function adminFailureResponse(
  code: AdminFailure,
  message: string,
): NextResponse {
  switch (code) {
    case "not_found":
    case "unknown_module":
      return notFound(message);
    case "self_admin_demote":
    case "self_disable":
    case "last_active_admin":
      return forbidden(message);
  }
}

export function invalidBody(message?: string): NextResponse {
  return validationFailed(message);
}
