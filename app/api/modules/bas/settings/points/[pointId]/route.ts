import { ok, withBasSettings } from "@/lib/modules/bas/route-helpers";
import { settingsResult } from "@/lib/modules/bas/settings-http";
import {
  setBasPointEquipment,
  setBasPointLabel,
  setBasPointRole,
  setBasPointVisibility,
} from "@/lib/modules/bas/settings-service";
import {
  updatePointSchema,
  type UpdatePointInput,
} from "@/lib/validation/bas-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/modules/bas/settings/points/[pointId]";

/**
 * Change one thing about one point: show or hide it (B8.3), set, change or
 * clear its label (B8.4), its role or its equipment (B8.5).
 *
 * One point, one field per request. The schema is strict and accepts exactly
 * one of `visible`, `label`, `role` or `equipmentId` - never two, never
 * anything else. There is deliberately no way to reach `is_active` from here,
 * because hiding costs nothing and deactivating loses data the station will
 * overwrite, and the two must not sit on one payload. Nor `niagara_history_name`:
 * it is the oBIX key, and editing it stops the point collecting. Each field
 * dispatches to its own service function with its own audit action, so one
 * request is one audit row.
 *
 * A role and an equipment together are the bulk endpoint's business
 * (`points/bulk`), where accepting a suggestion is one human action on both.
 *
 * `withBasSettings`, like every route under settings/**: module-admin grant or
 * 404. A point on a station outside the viewer's scope is also 404, through
 * `point_not_found`, so a point that exists and is not theirs reads the same as
 * one that does not exist.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ pointId: string }> },
) {
  return withBasSettings(
    ROUTE,
    async (viewer, input: UpdatePointInput) => {
      const { pointId } = await params;
      return settingsResult(
        () => {
          if (input.visible !== undefined) {
            return setBasPointVisibility(viewer, pointId, { visible: input.visible });
          }
          if (input.label !== undefined) {
            return setBasPointLabel(viewer, pointId, { label: input.label });
          }
          if (input.role !== undefined) {
            return setBasPointRole(viewer, pointId, { role: input.role });
          }
          return setBasPointEquipment(viewer, pointId, {
            equipmentId: input.equipmentId ?? null,
          });
        },
        (result) => ok(result),
      );
    },
    async () => {
      const body: unknown = await request.json().catch(() => null);
      const parsed = updatePointSchema.safeParse(body);
      if (!parsed.success) {
        return { ok: false, message: parsed.error.issues[0]?.message };
      }
      return { ok: true, data: parsed.data };
    },
  );
}
