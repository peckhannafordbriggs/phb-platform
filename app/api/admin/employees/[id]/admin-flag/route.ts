import { ok } from "@/lib/api/response";
import {
  adminFailureResponse,
  invalidBody,
  withAdmin,
} from "@/lib/admin/route-helpers";
import { setAdminFlag } from "@/lib/admin/service";
import { adminFlagBodySchema } from "@/lib/validation/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmin("/api/admin/employees/[id]/admin-flag", async (viewer) => {
    const { id } = await params;

    const body: unknown = await request.json().catch(() => null);
    const parsed = adminFlagBodySchema.safeParse(body);
    if (!parsed.success) return invalidBody(parsed.error.issues[0]?.message);

    const result = await setAdminFlag(
      viewer.id,
      id,
      parsed.data.isPlatformAdmin,
    );
    if (!result.ok) return adminFailureResponse(result.code, result.message);

    return ok(result.data);
  });
}
