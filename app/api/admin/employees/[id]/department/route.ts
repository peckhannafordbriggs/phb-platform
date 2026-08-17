import { notFound, ok, validationFailed } from "@/lib/api/response";
import { withAdmin } from "@/lib/admin/route-helpers";
import { setDepartment } from "@/lib/profile/service";
import {
  departmentBodySchema,
  profileIssueMessage,
} from "@/lib/validation/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * An admin changes an employee's department.
 *
 * Admin-only, with no self-service counterpart anywhere. There is deliberately no
 * /api/me/department: department drives the admin employee filter, so letting
 * people set their own would turn it into a record of what they call themselves.
 * The absence of that route is the enforcement - not a flag inside a shared one.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmin("/api/admin/employees/[id]/department", async (viewer) => {
    const { id } = await params;

    const body: unknown = await request.json().catch(() => null);

    const parsed = departmentBodySchema.safeParse(body);
    if (!parsed.success) {
      return validationFailed(profileIssueMessage(parsed.error, "department"));
    }

    const result = await setDepartment(viewer.id, id, parsed.data.departmentId);

    if (!result.ok) {
      if (result.code === "not_found") return notFound(result.message);
      return validationFailed(result.message);
    }

    return ok(result.data);
  });
}
