import { z } from "zod";
import { denialResponse, requireModuleAdmin } from "@/lib/authz";
import { fail, ok, serverError, validationFailed } from "@/lib/api/response";
import { logger, logUnexpected } from "@/lib/logger";
import { clearKbIndex, KB_CLEAR_CONFIRMATION } from "@/lib/modules/knowledge-base/clear";
import { KNOWLEDGE_BASE_MODULE_KEY } from "@/lib/modules/knowledge-base/constants";
import { KbSyncInProgressError } from "@/lib/modules/knowledge-base/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/knowledge-base/index/clear";

// Checked here, not only on the screen.
const body = z.object({ confirm: z.literal(KB_CLEAR_CONFIRMATION) }).strict();

/**
 * POST /api/modules/knowledge-base/index/clear  { "confirm": "clear" }
 *
 * Empties the index so the next sync rebuilds it. Knowledge Base module
 * admins only (404 otherwise). 409 while a sync is queued or running. The
 * question history is kept (lib/modules/knowledge-base/clear.ts).
 */
export async function POST(request: Request) {
  const access = await requireModuleAdmin(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  const parsed = body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFailed(`Type "${KB_CLEAR_CONFIRMATION}" to confirm.`);

  try {
    const outcome = await clearKbIndex({ actorId: access.viewer.id });
    logger.info("kb.index_cleared", {
      route: ROUTE,
      employeeId: access.viewer.id,
      moduleKey: KNOWLEDGE_BASE_MODULE_KEY,
      count: outcome.chunks,
    });
    return ok(outcome);
  } catch (error) {
    if (error instanceof KbSyncInProgressError) {
      return fail(409, "sync_in_progress", "A sync is queued or running. Clear the index after it finishes.");
    }
    logUnexpected("kb.index_clear_failed", error, { route: ROUTE, employeeId: access.viewer.id });
    return serverError();
  }
}
