import { updateResultSchema } from "@/lib/modules/freeze-protection/schemas";
import { updateResult } from "@/lib/modules/freeze-protection/verifications";
import { type IdParams, handleWrite } from "../../handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** One save from the step pane. Returns the line with its new disposition's inputs. */
export async function PATCH(request: Request, { params }: IdParams) {
  const { id } = await params;
  return handleWrite(request, {
    route: "/api/modules/freeze-protection/results/[id]",
    event: "fp.result_update_failed",
    schema: updateResultSchema,
    run: (actorId, body) => updateResult(actorId, id, body),
  });
}
