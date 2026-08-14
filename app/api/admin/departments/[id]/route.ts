import { ok } from "@/lib/api/response";
import {
  adminFailureResponse,
  invalidBody,
  withAdmin,
} from "@/lib/admin/route-helpers";
import { updateDepartment } from "@/lib/admin/service";
import { listItemPatchSchema } from "@/lib/validation/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Rename or hide. There is no DELETE: hiding must not break employees already
// assigned to the value.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmin("/api/admin/departments/[id]", async (viewer) => {
    const { id } = await params;

    const body: unknown = await request.json().catch(() => null);
    const parsed = listItemPatchSchema.safeParse(body);
    if (!parsed.success) return invalidBody(parsed.error.issues[0]?.message);

    const result = await updateDepartment(viewer.id, id, parsed.data);
    if (!result.ok) return adminFailureResponse(result.code, result.message);

    return ok(result.data);
  });
}
