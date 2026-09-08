import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import {
  deleteBasBuilding,
  updateBasBuilding,
} from "@/lib/modules/bas/settings-service";
import {
  updateBuildingSchema,
  type UpdateBuildingInput,
} from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/buildings/[siteId]";

/**
 * Rename a building, move its timezone, or change its address or notes.
 *
 * The timezone is set HERE and nowhere else. The collector stopped writing it
 * when `ensure_site` became `lookup_site` in phb-bas - two writers to one field
 * is the problem B7 removes, and a collector that overwrote it on every
 * discover would quietly undo whatever was chosen on this screen.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  return withBasSettings(
    ROUTE,
    async (viewer, input: UpdateBuildingInput) => {
      const { siteId } = await params;
      return settingsResult(
        () => updateBasBuilding(viewer, siteId, input),
        (result) => ok(result),
      );
    },
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = updateBuildingSchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues[0]?.message };
      }
      return { ok: true, data: parsed.data };
    },
  );
}

/** Delete a building, but only one with no stations and no equipment. */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  return withBasSettings(ROUTE, async (viewer) => {
    const { siteId } = await params;
    return settingsResult(
      () => deleteBasBuilding(viewer, siteId),
      (result) => ok(result),
    );
  });
}
