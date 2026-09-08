import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import { createBasBuilding } from "@/lib/modules/bas/settings-service";
import {
  createBuildingSchema,
  type CreateBuildingInput,
} from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/buildings";

/**
 * Create a building under a project.
 *
 * The org is NOT in the payload. It is read from the project, because
 * bas_sites.org_id is redundant with bas_projects.org_id and the
 * bas_sites_project_org_match trigger refuses a row where the two disagree.
 * Accepting an org here would be offering the caller a way to fail that check.
 */
export async function POST(request: Request) {
  return withBasSettings(
    ROUTE,
    async (viewer, input: CreateBuildingInput) =>
      settingsResult(
        () => createBasBuilding(viewer, input),
        (created) => ok(created, 201),
      ),
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = createBuildingSchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues[0]?.message };
      }
      return { ok: true, data: parsed.data };
    },
  );
}
