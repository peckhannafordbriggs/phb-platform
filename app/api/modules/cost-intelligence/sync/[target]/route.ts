import { denialResponse, requireModuleAdmin } from "@/lib/authz";
import { fail, notFound, ok, serverError } from "@/lib/api/response";
import { logUnexpected, logger } from "@/lib/logger";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { ProjectSyncInProgressError, syncProjects } from "@/lib/modules/cost-intelligence/project-sync";
import { SkillSyncInProgressError, syncSkills } from "@/lib/modules/cost-intelligence/skill-sync";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * POST /api/modules/cost-intelligence/sync/skills | /sync/projects
 *
 * Sync the skill catalog or the project list from its folder. Cost
 * Intelligence module admins only; anyone else gets 404, like every module
 * settings route. A sync that ran but failed (wrong folder, nothing found) is
 * still 200: the outcome carries `status: "failed"` and a `message` the screen
 * shows. 409 while another sync of the same kind is running.
 */
export async function POST(_request: Request, { params }: { params: Promise<{ target: string }> }) {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  const { target } = await params;
  if (target !== "skills" && target !== "projects") return notFound();
  const route = `/api/modules/cost-intelligence/sync/${target}`;

  const started = Date.now();
  try {
    const options = { trigger: "manual" as const, triggeredById: access.viewer.id };
    const outcome = target === "skills" ? await syncSkills(options) : await syncProjects(options);
    logger.info(`cip.${target}_synced`, {
      route,
      employeeId: access.viewer.id,
      moduleKey: COST_INTELLIGENCE_MODULE_KEY,
      outcome: outcome.status,
      count: "skillsSeen" in outcome ? outcome.skillsSeen : outcome.projectsSeen,
      durationMs: Date.now() - started,
    });
    return ok(outcome);
  } catch (error) {
    if (error instanceof SkillSyncInProgressError || error instanceof ProjectSyncInProgressError) {
      return fail(409, "sync_in_progress", error.message);
    }
    logUnexpected(`cip.${target}_sync_failed`, error, { route, employeeId: access.viewer.id });
    return serverError();
  }
}
