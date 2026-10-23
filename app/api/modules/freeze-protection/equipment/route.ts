import { addEquipment } from "@/lib/modules/freeze-protection/equipment";
import { createEquipmentSchema } from "@/lib/modules/freeze-protection/schemas";
import { handleWrite } from "../handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A unit from the project's equipment schedule. Name required; type and area served optional. */
export async function POST(request: Request) {
  return handleWrite(request, {
    route: "/api/modules/freeze-protection/equipment",
    event: "fp.equipment_create_failed",
    schema: createEquipmentSchema,
    run: (actorId, body) => addEquipment(actorId, body),
    status: 201,
  });
}
