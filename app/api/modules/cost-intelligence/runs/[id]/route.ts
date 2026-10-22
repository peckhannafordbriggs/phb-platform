import { z } from "zod";
import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { fail, ok, serverError, validationFailed } from "@/lib/api/response";
import { cipRequestFailed } from "@/lib/modules/cost-intelligence/audit";
import { COST_INTELLIGENCE_MODULE_KEY } from "@/lib/modules/cost-intelligence/constants";
import { ANSWER_MAX, RUN_ERROR_STATUS, answerCheckpoint, cancelRun, continueRun } from "@/lib/modules/cost-intelligence/runs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/cost-intelligence/runs/[id]";

const actionSchema = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("cancel") }),
  z.strictObject({ action: z.literal("continue") }),
  z.strictObject({ action: z.literal("answer"), answer: z.string().max(ANSWER_MAX) }),
]);

/**
 * Act on a run: `{ action: "cancel" }`, `{ action: "continue" }` on a failed
 * run, or `{ action: "answer", answer }` to answer its open question and
 * resume it. Any Cost Intelligence member may.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const access = await requireModuleAccess(COST_INTELLIGENCE_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);

  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return validationFailed();

  try {
    const { id } = await params;
    const body = parsed.data;
    const result =
      body.action === "cancel"
        ? await cancelRun(access.viewer.id, id)
        : body.action === "continue"
          ? await continueRun(access.viewer.id, id)
          : await answerCheckpoint(access.viewer.id, id, body.answer);
    if (!result.ok) return fail(RUN_ERROR_STATUS[result.code], result.code, result.message);
    return ok(result.data);
  } catch (error) {
    await cipRequestFailed("cip.run_action_failed", error, { route: ROUTE, employeeId: access.viewer.id });
    return serverError();
  }
}
