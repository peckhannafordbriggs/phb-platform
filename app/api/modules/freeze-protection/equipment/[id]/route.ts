import { deleteEquipment, updateEquipment } from "@/lib/modules/freeze-protection/equipment";
import { updateEquipmentSchema } from "@/lib/modules/freeze-protection/schemas";
import { type IdParams, handleWrite } from "../../handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/freeze-protection/equipment/[id]";

export async function PATCH(request: Request, { params }: IdParams) {
  const { id } = await params;
  return handleWrite(request, {
    route: ROUTE,
    event: "fp.equipment_update_failed",
    schema: updateEquipmentSchema,
    run: (actorId, body) => updateEquipment(actorId, id, body),
  });
}

/** Removes the unit and its results in every round. */
export async function DELETE(request: Request, { params }: IdParams) {
  const { id } = await params;
  return handleWrite(request, {
    route: ROUTE,
    event: "fp.equipment_delete_failed",
    schema: null,
    run: (actorId) => deleteEquipment(actorId, id),
  });
}
