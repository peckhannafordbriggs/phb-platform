import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { notFound, ok } from "@/lib/api/response";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { listEquipment } from "@/lib/modules/freeze-protection/equipment";
import { deleteProject, getProject, updateProject } from "@/lib/modules/freeze-protection/projects";
import { updateProjectSchema } from "@/lib/modules/freeze-protection/schemas";
import { type IdParams, handleWrite } from "../../handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/freeze-protection/projects/[id]";

/** The project, its verification, and its register. */
export async function GET(_request: Request, { params }: IdParams) {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);
  const { id } = await params;
  const project = await getProject(id);
  if (project === null) return notFound("Project not found.");
  return ok({ project, equipment: await listEquipment(id) });
}

/** Job number, name, verification date, transmittal. */
export async function PATCH(request: Request, { params }: IdParams) {
  const { id } = await params;
  return handleWrite(request, {
    route: ROUTE,
    event: "fp.project_update_failed",
    schema: updateProjectSchema,
    run: (actorId, body) => updateProject(actorId, id, body),
  });
}

export async function DELETE(request: Request, { params }: IdParams) {
  const { id } = await params;
  return handleWrite(request, {
    route: ROUTE,
    event: "fp.project_delete_failed",
    schema: null,
    run: (actorId) => deleteProject(actorId, id),
  });
}
