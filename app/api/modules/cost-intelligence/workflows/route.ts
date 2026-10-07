import { z } from "zod";
import { denialResponse, requireModuleAdmin } from "@/lib/authz";
import { fail, ok, serverError, validationFailed } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { WORKFLOW_ERROR_STATUS, createWorkflow } from "@/lib/modules/cost-intelligence/workflows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/cost-intelligence/workflows";

/** Shape only. Trimming, length and name clashes are the service's job. */
const createSchema = z.strictObject({
  name: z.string(),
  description: z.string().nullable().optional(),
});

/** Create a Draft workflow with no steps. PCEs only; anyone else gets 404. */
export async function POST(request: Request) {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFailed();

  try {
    const result = await createWorkflow(access.viewer.id, parsed.data);
    if (!result.ok) return fail(WORKFLOW_ERROR_STATUS[result.code], result.code, result.message);
    return ok(result.data, 201);
  } catch (error) {
    logUnexpected("cip.workflow_create_failed", error, { route: ROUTE, employeeId: access.viewer.id });
    return serverError();
  }
}
