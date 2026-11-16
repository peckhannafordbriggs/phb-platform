import { z } from "zod";
import { denialResponse, hasModuleAdmin, requireModuleAccess } from "@/lib/authz";
import { ok, serverError, validationFailed } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import { listConversations } from "@/lib/modules/knowledge-base/ask";
import { KNOWLEDGE_BASE_MODULE_KEY } from "@/lib/modules/knowledge-base/constants";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const params = z.object({
  mine: z.enum(["1"]).optional(),
  // The last row shown: its updatedAt and id.
  before: z.iso.datetime().optional(),
  beforeId: z.uuid().optional(),
});

/**
 * GET /api/modules/knowledge-base/history[?mine=1][&before=<iso>&beforeId=<id>]
 *
 * The question history, newest activity first, 30 a page: the viewer's own,
 * or everyone's for a Knowledge Base module admin (who can narrow to their own
 * with `mine=1`). Anyone with the grant; 404 otherwise.
 */
export async function GET(request: Request) {
  const access = await requireModuleAccess(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  const url = new URL(request.url);
  const parsed = params.safeParse({
    mine: url.searchParams.get("mine") ?? undefined,
    before: url.searchParams.get("before") ?? undefined,
    beforeId: url.searchParams.get("beforeId") ?? undefined,
  });
  if (!parsed.success || Boolean(parsed.data.before) !== Boolean(parsed.data.beforeId)) {
    return validationFailed("The page marker is not valid.");
  }
  try {
    const everyone = !parsed.data.mine && (await hasModuleAdmin(access.viewer.id, KNOWLEDGE_BASE_MODULE_KEY));
    return ok(
      await listConversations({
        ...(everyone ? {} : { employeeId: access.viewer.id }),
        ...(parsed.data.before && parsed.data.beforeId
          ? { before: { updatedAt: new Date(parsed.data.before), id: parsed.data.beforeId } }
          : {}),
      }),
    );
  } catch (error) {
    logUnexpected("kb.history_failed", error, { employeeId: access.viewer.id });
    return serverError();
  }
}
