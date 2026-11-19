import { denialResponse, requireModuleAdmin } from "@/lib/authz";
import { fail, ok, serverError } from "@/lib/api/response";
import { logger, logUnexpected } from "@/lib/logger";
import { getKbIndexStatus } from "@/lib/modules/knowledge-base/admin";
import { KNOWLEDGE_BASE_MODULE_KEY } from "@/lib/modules/knowledge-base/constants";
import {
  KbSourceNotConfiguredError,
  KbSyncInProgressError,
  queueKbSync,
} from "@/lib/modules/knowledge-base/sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/knowledge-base/sync";

/**
 * GET  /api/modules/knowledge-base/sync   the admin screen's status: recent
 *      syncs, documents by state, files that could not be read. Polled while
 *      a sync is queued or running.
 * POST /api/modules/knowledge-base/sync   the Index button: queue a sync for
 *      the worker job. 202 with the queued sync; 409 while one is queued or
 *      running; 503 when the library is not configured.
 *
 * Knowledge Base module admins only; anyone else gets 404, like every module
 * settings route. The sync itself never runs in this process: a full index
 * takes far longer than a request may.
 */
export async function GET() {
  const access = await requireModuleAdmin(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);
  try {
    return ok(await getKbIndexStatus());
  } catch (error) {
    logUnexpected("kb.status_failed", error, { route: ROUTE, employeeId: access.viewer.id });
    return serverError();
  }
}

export async function POST() {
  const access = await requireModuleAdmin(KNOWLEDGE_BASE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);
  try {
    const queued = await queueKbSync({ trigger: "manual", triggeredById: access.viewer.id });
    logger.info("kb.sync_queued", {
      route: ROUTE,
      employeeId: access.viewer.id,
      moduleKey: KNOWLEDGE_BASE_MODULE_KEY,
    });
    return ok(queued, 202);
  } catch (error) {
    if (error instanceof KbSyncInProgressError) return fail(409, "sync_in_progress", error.message);
    if (error instanceof KbSourceNotConfiguredError) return fail(503, "kb_not_configured", error.message);
    logUnexpected("kb.sync_queue_failed", error, { route: ROUTE, employeeId: access.viewer.id });
    return serverError();
  }
}
