import { deleteBuilding, renameBuilding } from "@/lib/modules/freeze-protection/projects";
import { buildingSchema } from "@/lib/modules/freeze-protection/schemas";
import { type IdParams, handleWrite } from "../../handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/freeze-protection/buildings/[id]";

export async function PATCH(request: Request, { params }: IdParams) {
  const { id } = await params;
  return handleWrite(request, {
    route: ROUTE,
    event: "fp.building_update_failed",
    schema: buildingSchema,
    run: (actorId, body) => renameBuilding(actorId, id, body.name),
  });
}

/** Refused (409) while the building holds equipment, or when it is the project's last. */
export async function DELETE(request: Request, { params }: IdParams) {
  const { id } = await params;
  return handleWrite(request, {
    route: ROUTE,
    event: "fp.building_delete_failed",
    schema: null,
    run: (actorId) => deleteBuilding(actorId, id),
  });
}
