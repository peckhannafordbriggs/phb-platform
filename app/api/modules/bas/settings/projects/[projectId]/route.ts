import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import {
  deleteBasProject,
  updateBasProject,
} from "@/lib/modules/bas/settings-service";
import {
  updateProjectSchema,
  type UpdateProjectInput,
} from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/projects/[projectId]";

/** Rename a project, or change its notes. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  return withBasSettings(
    ROUTE,
    async (viewer, input: UpdateProjectInput) => {
      const { projectId } = await params;
      return settingsResult(
        () => updateBasProject(viewer, projectId, input),
        (result) => ok(result),
      );
    },
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = updateProjectSchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues[0]?.message };
      }
      return { ok: true, data: parsed.data };
    },
  );
}

/**
 * Delete a project, but only an empty one.
 *
 * Offered because B7 exists so that nobody needs psql: an admin who creates a
 * project by mistake can rename it, and without this could never remove it.
 *
 * A project with buildings under it is REFUSED, with a sentence naming how
 * many. bas_sites.project_id is RESTRICT so the database would refuse anyway;
 * the check exists to turn a constraint name into an explanation for someone
 * who has no other way to look.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ projectId: string }> },
) {
  return withBasSettings(ROUTE, async (viewer) => {
    const { projectId } = await params;
    return settingsResult(
      () => deleteBasProject(viewer, projectId),
      (result) => ok(result),
    );
  });
}
