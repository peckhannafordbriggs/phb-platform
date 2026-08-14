import { NextRequest } from "next/server";
import { denialResponse, requireAuthenticated } from "@/lib/authz";
import { ok, serverError, validationFailed } from "@/lib/api/response";
import { onboardingSchema } from "@/lib/validation/onboarding";
import { writeAuditEvent } from "@/lib/audit";
import { prisma } from "@/lib/db";
import { logUnexpected } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // requireAuthenticated, not requireEmployee: by definition the profile is not
  // complete yet.
  const access = await requireAuthenticated();
  if (!access.ok) return denialResponse(access.denial);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return validationFailed("The request body could not be read.");
  }

  const parsed = onboardingSchema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return validationFailed(first?.message ?? "The submitted values are not valid.");
  }

  const { firstName, lastName, positionId, positionOther, departmentId } =
    parsed.data;

  try {
    // Referenced rows must exist and be selectable. A hidden position or
    // department cannot be chosen, even by a caller bypassing the form.
    const department = await prisma.department.findFirst({
      where: { id: departmentId, status: "active" },
      select: { id: true },
    });
    if (department === null) {
      return validationFailed("Select a department from the list.");
    }

    if (positionId != null && positionId.length > 0) {
      const position = await prisma.position.findFirst({
        where: { id: positionId, status: "active" },
        select: { id: true },
      });
      if (position === null) {
        return validationFailed("Select a position from the list.");
      }
    }

    await prisma.$transaction(async (tx) => {
      await tx.employee.update({
        where: { id: access.viewer.id },
        // email is absent by construction. The address comes from the token and
        // is never accepted from a request body.
        data: {
          firstName,
          lastName,
          positionId: positionId != null && positionId.length > 0 ? positionId : null,
          positionOther:
            positionOther != null && positionOther.length > 0
              ? positionOther
              : null,
          departmentId,
          profileCompleted: true,
        },
      });

      await writeAuditEvent(tx, {
        action: "employee.profile_completed",
        actorEmployeeId: access.viewer.id,
        targetEmployeeId: access.viewer.id,
        metadata: {
          usedFreeTextPosition: positionOther != null && positionOther.length > 0,
        },
      });
    });

    return ok({ profileCompleted: true });
  } catch (error) {
    logUnexpected("onboarding.failed", error, {
      route: "/api/onboarding",
      employeeId: access.viewer.id,
    });
    return serverError();
  }
}
