import { ok } from "@/lib/api/response";
import { adminFailureResponse, withAdmin } from "@/lib/admin/route-helpers";
import { removeGrant } from "@/lib/admin/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; moduleKey: string }> },
) {
  return withAdmin(
    "/api/admin/employees/[id]/grants/[moduleKey]",
    async (viewer) => {
      const { id, moduleKey } = await params;

      const result = await removeGrant(viewer.id, id, moduleKey);
      if (!result.ok) return adminFailureResponse(result.code, result.message);

      return ok(result.data);
    },
  );
}
