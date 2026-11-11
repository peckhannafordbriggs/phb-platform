import { z } from "zod";
import { denialResponse, requireModuleAccess } from "@/lib/authz";
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
 * The shared question history: everyone's conversations, newest activity
 * first, 30 a page. `mine=1` narrows to the viewer's own. Anyone with the
 * Knowledge Base grant; 404 otherwise.
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
    return ok(
      await listConversations({
        ...(parsed.data.mine ? { employeeId: access.viewer.id } : {}),
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
