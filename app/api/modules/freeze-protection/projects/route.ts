import { denialResponse, requireModuleAccess } from "@/lib/authz";
import { ok } from "@/lib/api/response";
import { FREEZE_PROTECTION_MODULE_KEY } from "@/lib/modules/freeze-protection/constants";
import { createProject, listProjects } from "@/lib/modules/freeze-protection/projects";
import { createProjectSchema } from "@/lib/modules/freeze-protection/schemas";
import { handleWrite } from "../handle";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/freeze-protection/projects";

/** Every project, for the picker. */
export async function GET() {
  const access = await requireModuleAccess(FREEZE_PROTECTION_MODULE_KEY);
  if (!access.ok) return denialResponse(access.denial);
  return ok(await listProjects());
}

/** A project: job number, name, and its verification date (today if not given). */
export async function POST(request: Request) {
  return handleWrite(request, {
    route: ROUTE,
    event: "fp.project_create_failed",
    schema: createProjectSchema,
    run: (actorId, body) => createProject(actorId, body),
    status: 201,
  });
}
