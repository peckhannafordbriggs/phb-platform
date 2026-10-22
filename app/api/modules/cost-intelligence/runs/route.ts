import { z } from "zod";
import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { fail, ok, serverError, validationFailed } from "@/lib/api/response";
import { cipRequestFailed } from "@/lib/modules/cost-intelligence/audit";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { RUN_ERROR_STATUS, createRun } from "@/lib/modules/cost-intelligence/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/cost-intelligence/runs";

const createSchema = z.strictObject({ workflowId: z.string().min(1), projectId: z.string().min(1) });

/** Queue a run. Any Cost Intelligence member may start one. 201 with its id. */
export async function POST(request: Request) {
  const access = await requireModuleAccess(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  const parsed = createSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFailed();

  try {
    const result = await createRun(access.viewer.id, parsed.data);
    if (!result.ok) return fail(RUN_ERROR_STATUS[result.code], result.code, result.message);
    return ok(result.data, 201);
  } catch (error) {
    await cipRequestFailed("cip.run_create_failed", error, { route: ROUTE, employeeId: access.viewer.id });
    return serverError();
  }
}
