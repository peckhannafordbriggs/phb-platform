import { ok } from "@/lib/api/response";
import {
  adminFailureResponse,
  invalidBody,
  withAdmin,
} from "@/lib/admin/route-helpers";
import { addGrant } from "@/lib/admin/service";
import { grantBodySchema } from "@/lib/validation/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmin("/api/admin/employees/[id]/grants", async (viewer) => {
    const { id } = await params;

    const body: unknown = await request.json().catch(() => null);
    const parsed = grantBodySchema.safeParse(body);
    if (!parsed.success) return invalidBody(parsed.error.issues[0]?.message);

    // The acting admin comes from the session, never from the body.
    const result = await addGrant(viewer.id, id, parsed.data.moduleKey);
    if (!result.ok) return adminFailureResponse(result.code, result.message);

    return ok(result.data);
  });
}
