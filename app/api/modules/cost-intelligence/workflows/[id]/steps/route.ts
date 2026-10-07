import { z } from "zod";
import { denialResponse, requireModuleAdmin } from "@/lib/authz";
import { fail, ok, serverError, validationFailed } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { WORKFLOW_ERROR_STATUS, setWorkflowSteps } from "@/lib/modules/cost-intelligence/workflows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/cost-intelligence/workflows/[id]/steps";

/** Skill folder names in run order. Duplicates and unknown skills are the service's job. */
const stepsSchema = z.strictObject({
  steps: z.array(z.string().min(1).max(200)).max(50),
});

/** Replace the whole step list. PCEs only. */
export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  const parsed = stepsSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFailed();

  try {
    const { id } = await params;
    const result = await setWorkflowSteps(access.viewer.id, id, parsed.data.steps);
    if (!result.ok) return fail(WORKFLOW_ERROR_STATUS[result.code], result.code, result.message);
    return ok(result.data);
  } catch (error) {
    logUnexpected("cip.workflow_steps_failed", error, { route: ROUTE, employeeId: access.viewer.id });
    return serverError();
  }
}
