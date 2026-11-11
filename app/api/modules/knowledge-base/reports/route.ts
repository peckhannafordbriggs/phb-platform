import { denialResponse, requireModuleAdmin } from "@/lib/authz";
import { ok, serverError, validationFailed } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import { KNOWLEDGE_BASE_MODULE_KEY } from "@/lib/modules/knowledge-base/constants";
import { listReports } from "@/lib/modules/knowledge-base/reports";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/modules/knowledge-base/reports[?status=open|closed]
 *
 * The reported-answers queue: open reports oldest first (the default), or
 * closed ones newest first. Knowledge Base module admins only; 404 otherwise.
 */
export async function GET(request: Request) {
  const access = await requireModuleAdmin(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);
  const status = new URL(request.url).searchParams.get("status") ?? "open";
  if (status !== "open" && status !== "closed") return validationFailed("status is open or closed.");
  try {
    return ok(await listReports(status));
  } catch (error) {
    logUnexpected("kb.reports_failed", error, { employeeId: access.viewer.id });
    return serverError();
  }
}
