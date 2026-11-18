import { importEquipment } from "@/lib/modules/freeze-protection/import/commit";
import { importEquipmentSchema } from "@/lib/modules/freeze-protection/schemas";
import { handleWrite } from "../../handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Step 3 of the schedule import: the units the reviewer kept, saved in one transaction. */
export async function POST(request: Request) {
  return handleWrite(request, {
    route: "/api/modules/freeze-protection/import/commit",
    event: "fp.import_commit_failed",
    schema: importEquipmentSchema,
    run: (actorId, body) => importEquipment(actorId, body),
    status: 201,
  });
}
