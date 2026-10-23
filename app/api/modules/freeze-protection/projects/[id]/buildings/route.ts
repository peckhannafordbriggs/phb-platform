import { addBuilding } from "@/lib/modules/freeze-protection/projects";
import { buildingSchema } from "@/lib/modules/freeze-protection/schemas";
import { type IdParams, handleWrite } from "../../../handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: IdParams) {
  const { id } = await params;
  return handleWrite(request, {
    route: "/api/modules/freeze-protection/projects/[id]/buildings",
    event: "fp.building_create_failed",
    schema: buildingSchema,
    run: (actorId, body) => addBuilding(actorId, id, body.name),
    status: 201,
  });
}
