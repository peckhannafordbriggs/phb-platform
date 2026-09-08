import { ok } from "@/lib/api/response";
import {
  adminFailureResponse,
  invalidBody,
  withAdmin,
} from "@/lib/admin/route-helpers";
import { setModuleAdmin } from "@/lib/admin/service";
import { moduleAdminBodySchema } from "@/lib/validation/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Grant or remove administrative rights over ONE module (B7.2).
 *
 * A /api/admin/* route, so `withAdmin` and a 403 for a non-admin: deciding who
 * administers a module is a platform-admin act, and the existence of the admin
 * API is not a secret. That is a different question from what the rights
 * themselves let you reach - `/api/modules/bas/settings` answers 404, because
 * the module's own surface IS a secret from someone who cannot use it.
 *
 * PUT rather than POST/DELETE: the body carries the value the caller wants,
 * which makes it idempotent and makes an unchecked checkbox a first-class
 * request rather than a different verb on a different path.
 */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; moduleKey: string }> },
) {
  return withAdmin(
    "/api/admin/employees/[id]/grants/[moduleKey]/admin",
    async (viewer) => {
      const { id, moduleKey } = await params;

      const body: unknown = await request.json().catch(() => null);
      const parsed = moduleAdminBodySchema.safeParse(body);
      if (!parsed.success) return invalidBody(parsed.error.issues[0]?.message);

      // The acting admin comes from the session, never from the body.
      const result = await setModuleAdmin(
        viewer.id,
        id,
        moduleKey,
        parsed.data.isModuleAdmin,
      );
      if (!result.ok) return adminFailureResponse(result.code, result.message);

      return ok(result.data);
    },
  );
}
