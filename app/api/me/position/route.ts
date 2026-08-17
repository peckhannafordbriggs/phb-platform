import { denialResponse, requireEmployee } from "@/lib/authz";
import { notFound, ok, serverError, validationFailed } from "@/lib/api/response";
import { setPosition } from "@/lib/profile/service";
import { positionBodySchema, profileIssueMessage } from "@/lib/validation/profile";
import { logUnexpected } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/me/position";

/**
 * An employee changes their own position.
 *
 * The only profile field an employee may change about themselves. The target is
 * always the session's own employee id - there is no id in the path or the body,
 * so "edit someone else's profile" is not a request this route can express.
 *
 * What it will not accept: email, name, department, status, the admin flag. Those
 * are not fields on positionBodySchema, and it is a strict object, so they are
 * rejected rather than silently dropped. An employee who sends `departmentId`
 * gets a 422 saying so, not a 200 that ignored it.
 */
export async function PATCH(request: Request) {
  // requireEmployee, not requireAuthenticated: someone who has not completed
  // onboarding belongs in /api/onboarding, which sets the whole profile at once.
  const access = await requireEmployee();
  if (!access.ok) return denialResponse(access.denial);

  const body: unknown = await request.json().catch(() => null);

  const parsed = positionBodySchema.safeParse(body);
  if (!parsed.success) {
    return validationFailed(profileIssueMessage(parsed.error, "your position"));
  }

  try {
    const result = await setPosition(
      access.viewer.id,
      // Self, always. Not a parameter.
      access.viewer.id,
      parsed.data,
    );

    if (!result.ok) {
      // not_found cannot happen here - the viewer was just loaded from the
      // database by requireEmployee - but it is mapped rather than assumed away.
      if (result.code === "not_found") return notFound(result.message);
      return validationFailed(result.message);
    }

    return ok(result.data);
  } catch (error) {
    logUnexpected("profile.self_position_failed", error, {
      route: ROUTE,
      employeeId: access.viewer.id,
    });
    return serverError();
  }
}
