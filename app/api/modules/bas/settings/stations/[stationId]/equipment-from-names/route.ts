import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import { createEquipmentFromNames } from "@/lib/modules/bas/settings-service";
import {
  equipmentFromNamesSchema,
  type EquipmentFromNamesInput,
} from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/stations/[stationId]/equipment-from-names";

/**
 * "Create N pieces of equipment from name prefixes", confirmed (2026-11-19).
 *
 * WHAT IT ACCEPTS. `{ rows: [{ key, name, equipType? }] }` - the preview's
 * rows a person kept, by the key the preview derived, with the name and type
 * they settled on. No point ids: the service derives each row's points again
 * from the station's names, so this route can only ever attach the points a
 * preview of this station would show, and never a point that already has
 * equipment.
 *
 * WHAT HAPPENS ON FAILURE. Nothing. A key the station no longer derives is
 * 409 `preview_stale`; two rows that would be one piece of equipment are 409
 * `name_taken`; a new row with no type, or a type not in the vocabulary, is
 * 422 `equipment_type_not_found`; a station on no building is 409
 * `station_unassigned`. Every check runs before the transaction opens.
 *
 * WHAT COMES BACK. `{ created, matched, pointsAttached, pointsUnchanged }`.
 *
 * Audited as one `bas.equipment_from_names` row for the action, one
 * `bas.equipment_created` per new piece of equipment and one
 * `bas.point_equipment_changed` per point, both carrying
 * `source: "name_prefixes"`. Module admins only, like every settings route.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ stationId: string }> },
) {
  return withBasSettings(
    ROUTE,
    async (viewer, input: EquipmentFromNamesInput) => {
      const { stationId } = await params;
      return settingsResult(
        () => createEquipmentFromNames(viewer, stationId, input),
        (result) => ok(result),
      );
    },
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = equipmentFromNamesSchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues[0]?.message };
      }
      return { ok: true, data: parsed.data };
    },
  );
}
