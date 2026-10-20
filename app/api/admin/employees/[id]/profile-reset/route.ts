import { ok } from "@/lib/api/response";
import { adminFailureResponse, withAdmin } from "@/lib/admin/route-helpers";
import { resetProfile } from "@/lib/admin/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Asks an employee to complete their profile again. No body: the action has
 * no parameters, and nothing sent is read. See resetProfile for why this ends
 * the person's session as well as clearing the flag.
 */
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAdmin("/api/admin/employees/[id]/profile-reset", async (viewer) => {
    const { id } = await params;

    const result = await resetProfile(viewer.id, id);
    if (!result.ok) return adminFailureResponse(result.code, result.message);

    return ok(result.data);
  });
}
