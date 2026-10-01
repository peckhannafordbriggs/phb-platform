import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import { listBuildingEquipment } from "@/lib/modules/bas/settings-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/buildings/[siteId]/equipment";

/**
 * One building's equipment, for the picker and the equipment panel on the
 * Points list (B8.5).
 *
 * Under the building rather than the station, because that is where equipment
 * lives: `bas_equipment.site_id`. Two stations in one building share an RTU;
 * a station attached to no building has no equipment to offer and the Points
 * list says so instead of calling this.
 *
 * Creating equipment is `POST /settings/equipment` with the building in the
 * body, like stations and buildings; editing and deleting are on
 * `/settings/equipment/[equipmentId]`.
 *
 * `withBasSettings`: module-admin grant or 404. A building outside the viewer's
 * scope is also 404, through `building_not_found`.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ siteId: string }> },
) {
  return withBasSettings(ROUTE, async (viewer) => {
    const { siteId } = await params;
    return settingsResult(
      () => listBuildingEquipment(viewer, siteId),
      (list) => ok(list),
    );
  });
}
