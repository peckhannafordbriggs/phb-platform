import { ok } from "@/lib/api/response";
import {
  adminFailureResponse,
  invalidBody,
  withAdmin,
} from "@/lib/admin/route-helpers";
import { bulkStatus } from "@/lib/admin/service";
import { bulkStatusBodySchema } from "@/lib/validation/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Enable or disable a selection of employees.
 *
 * Mirrors /api/admin/grants/bulk, including the important part: each employee is
 * processed individually and gets its own audit event, and each goes through the
 * same setStatus that enforces the guardrails - so a bulk disable cannot leave
 * zero active admins or disable the acting admin, and the report says which
 * members of the selection were refused and why.
 */
export async function POST(request: Request) {
  return withAdmin("/api/admin/status/bulk", async (viewer) => {
    const body: unknown = await request.json().catch(() => null);
    const parsed = bulkStatusBodySchema.safeParse(body);
    if (!parsed.success) return invalidBody(parsed.error.issues[0]?.message);

    const { employeeIds, status } = parsed.data;

    const result = await bulkStatus(viewer.id, employeeIds, status);
    if (!result.ok) return adminFailureResponse(result.code, result.message);

    return ok(result.data);
  });
}
