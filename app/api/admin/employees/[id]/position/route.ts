import { notFound, ok, validationFailed } from "@/lib/api/response";
import { withAdmin } from "@/lib/admin/route-helpers";
import { setPosition } from "@/lib/profile/service";
import { positionBodySchema, profileIssueMessage } from "@/lib/validation/profile";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * An admin changes an employee's position.
 *
 * The same service call and the same schema as /api/me/position - only the
 * authorization and the target differ. That is how the two paths coexist: there
 * is one implementation of "set a position", so the validation, the hidden-value
 * check and the audit event cannot drift apart between them.
 *
 * An admin may do this to anyone, including themselves.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmin("/api/admin/employees/[id]/position", async (viewer) => {
    const { id } = await params;

    const body: unknown = await request.json().catch(() => null);

    const parsed = positionBodySchema.safeParse(body);
    if (!parsed.success) {
      return validationFailed(profileIssueMessage(parsed.error, "position"));
    }

    const result = await setPosition(viewer.id, id, parsed.data);

    if (!result.ok) {
      if (result.code === "not_found") return notFound(result.message);
      return validationFailed(result.message);
    }

    return ok(result.data);
  });
}
