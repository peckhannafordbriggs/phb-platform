import { ok } from "@/lib/api/response";
import {
  adminFailureResponse,
  invalidBody,
  withAdmin,
} from "@/lib/admin/route-helpers";
import { bulkGrants } from "@/lib/admin/service";
import { bulkGrantBodySchema } from "@/lib/validation/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  return withAdmin("/api/admin/grants/bulk", async (viewer) => {
    const body: unknown = await request.json().catch(() => null);
    const parsed = bulkGrantBodySchema.safeParse(body);
    if (!parsed.success) return invalidBody(parsed.error.issues[0]?.message);

    const { employeeIds, moduleKey, action } = parsed.data;

    // Each employee gets its own audit event - a bulk action is not one event
    // covering many people.
    const result = await bulkGrants(viewer.id, employeeIds, moduleKey, action);
    if (!result.ok) return adminFailureResponse(result.code, result.message);

    return ok(result.data);
  });
}
