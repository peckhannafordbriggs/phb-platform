import { z } from "zod";
import { denialResponse, requireModuleAdmin } from "@/lib/authz";
import { fail, ok, serverError, validationFailed } from "@/lib/api/response";
import { logUnexpected } from "@/lib/logger";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { WORKFLOW_ERROR_STATUS, deleteWorkflow, updateWorkflow } from "@/lib/modules/cost-intelligence/workflows";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/cost-intelligence/workflows/[id]";

type Params = { params: Promise<{ id: string }> };

/** Shape only. Strict, so a misspelled field is a 422 instead of a silent no-op. */
const patchSchema = z.strictObject({
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  status: z.enum(["draft", "active", "paused"]).optional(),
});

/** Rename, edit the description, or change status. PCEs only. */
export async function PATCH(request: Request, { params }: Params) {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFailed();

  try {
    const { id } = await params;
    const result = await updateWorkflow(access.viewer.id, id, parsed.data);
    if (!result.ok) return fail(WORKFLOW_ERROR_STATUS[result.code], result.code, result.message);
    return ok(result.data);
  } catch (error) {
    logUnexpected("cip.workflow_update_failed", error, { route: ROUTE, employeeId: access.viewer.id });
    return serverError();
  }
}

/** Delete a Draft. Active and Paused workflows are refused with 409. PCEs only. */
export async function DELETE(_request: Request, { params }: Params) {
  const access = await requireModuleAdmin(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  try {
    const { id } = await params;
    const result = await deleteWorkflow(access.viewer.id, id);
    if (!result.ok) return fail(WORKFLOW_ERROR_STATUS[result.code], result.code, result.message);
    return ok(result.data);
  } catch (error) {
    logUnexpected("cip.workflow_delete_failed", error, { route: ROUTE, employeeId: access.viewer.id });
    return serverError();
  }
}
