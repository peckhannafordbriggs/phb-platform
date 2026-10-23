import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { ok } from "@/lib/api/response";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { deleteEquipment, getHistory, updateEquipment } from "@/lib/modules/freeze-protection/equipment";
import { updateEquipmentSchema } from "@/lib/modules/freeze-protection/schemas";
import { type IdParams, handleWrite } from "../../handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/freeze-protection/equipment/[id]";

/** The unit's history, newest first, from the audit log. */
export async function GET(_request: Request, { params }: IdParams) {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);
  const { id } = await params;
  return ok({ history: await getHistory(id) });
}

/** One save from the step pane: schedule fields and verification answers. */
export async function PATCH(request: Request, { params }: IdParams) {
  const { id } = await params;
  return handleWrite(request, {
    route: ROUTE,
    event: "fp.equipment_update_failed",
    schema: updateEquipmentSchema,
    run: (actorId, body) => updateEquipment(actorId, id, body),
  });
}

/** Removes the unit and its results. Its history stays in the audit log. */
export async function DELETE(request: Request, { params }: IdParams) {
  const { id } = await params;
  return handleWrite(request, {
    route: ROUTE,
    event: "fp.equipment_delete_failed",
    schema: null,
    run: (actorId) => deleteEquipment(actorId, id),
  });
}
