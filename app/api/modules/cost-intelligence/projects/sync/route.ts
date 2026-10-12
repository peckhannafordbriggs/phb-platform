import { denialResponse, requireModuleAdmin } from "@/lib/authz";
import { fail, ok, serverError } from "@/lib/api/response";
import { logUnexpected, logger } from "@/lib/logger";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { ProjectSyncInProgressError, syncProjects } from "@/lib/modules/cost-intelligence/project-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/cost-intelligence/projects/sync";

/**
 * Sync the project list from the BID-DOC folder. Cost Intelligence module
 * admins only; anyone else gets 404, like every module settings route.
 *
 * A sync that ran but failed (wrong folder, no projects) is still 200: the
 * outcome carries `status: "failed"` and a `message` the screen shows.
 */
export async function POST() {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  const started = Date.now();
  try {
    const outcome = await syncProjects({ trigger: "manual", triggeredById: access.viewer.id });
    logger.info("cip.projects_synced", {
      route: ROUTE,
      employeeId: access.viewer.id,
      moduleKey: COST_INTELLIGENCE_MODULE_KEY,
      outcome: outcome.status,
      count: outcome.projectsSeen,
      durationMs: Date.now() - started,
    });
    return ok(outcome);
  } catch (error) {
    if (error instanceof ProjectSyncInProgressError) {
      return fail(409, "sync_in_progress", error.message);
    }
    logUnexpected("cip.projects_sync_failed", error, { route: ROUTE, employeeId: access.viewer.id });
    return serverError();
  }
}
